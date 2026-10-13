//! Thin wrappers around the Windows shell: launching, icons, desktop scan.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::c_void,
    fs,
    mem::size_of,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};
use windows::{
    core::{Interface, GUID, PCWSTR},
    Win32::{
        Foundation::{HWND, SIZE},
        Graphics::Gdi::{
            DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::{
            Shell::{
                FOLDERID_Desktop, FOLDERID_PublicDesktop, IShellItemImageFactory, SHCreateItemFromParsingName, SHGetKnownFolderPath,
                ILFree, IShellItem, IShellLinkW, SHGetIDListFromObject, ShellExecuteExW, ShellExecuteW, ShellLink, KF_FLAG_DEFAULT,
                SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, SIIGBF, SIIGBF_ICONONLY,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "ShortcutLauncher";
/// Icons are requested at the largest size Windows has (256 px) and stored at half that, so they stay sharp on high-DPI screens.
const ICON_SIZE: i32 = 256;
const STORED_SIZE: usize = 128;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Opens a file, folder, URL or shortcut with its default handler.
pub fn launch(target: &str, args: &str, admin: bool) -> Result<(), String> {
    let verb = wide(if admin { "runas" } else { "open" });
    let file = wide(target);
    let params = wide(args);

    let is_binary = Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "exe" | "bat" | "cmd" | "com"))
        .unwrap_or(false);
    let dir = if is_binary {
        Path::new(target)
            .parent()
            .and_then(|p| p.to_str())
            .filter(|p| !p.is_empty())
            .map(wide)
    } else {
        None
    };

    let result = unsafe {
        ShellExecuteW(
            None::<HWND>,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            if args.trim().is_empty() { PCWSTR::null() } else { PCWSTR(params.as_ptr()) },
            dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code > 32 {
        Ok(())
    } else if admin && code == 5 {
        Err("Administrator prompt was cancelled".into())
    } else {
        Err(format!("Could not open \"{target}\" (code {code})"))
    }
}

/// Opens the standard Windows "Properties" window for a file or folder.
pub fn show_properties(target: &str) -> Result<(), String> {
    if !Path::new(target).exists() {
        return Err("This shortcut points to something that no longer exists".into());
    }
    let verb = wide("properties");
    let file = wide(target);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| format!("Could not open the properties: {e}"))
}

/// Shows the target in Explorer with the file selected.
pub fn reveal(target: &str) -> Result<(), String> {
    let path = Path::new(target);
    let mut cmd = Command::new("explorer.exe");
    if path.is_dir() {
        cmd.arg(target);
    } else if path.exists() {
        cmd.raw_arg(format!("/select,\"{target}\""));
    } else {
        return Err("This shortcut points to something that no longer exists".into());
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The shell hands out icons unreliably when many threads ask at once, so they are fetched one at a time.
static ICON_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Returns the shell icon of a path as a `data:image/png` URL.
pub fn icon_data_url(path: &str) -> Option<String> {
    if !path.starts_with("shell:") && !Path::new(path).exists() {
        return None;
    }
    let _one_at_a_time = ICON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        let com_ready = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let mut png = None;
        for attempt in 0..3 {
            png = icon_png(path);
            if png.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(40 * (attempt + 1)));
        }
        if com_ready {
            CoUninitialize();
        }
        png.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    }
}

/// Raw straight-alpha RGBA pixels of the shell icon for `path`, as `(pixels, width, height)`.
unsafe fn icon_pixels(path: &str, size: i32, flags: SIIGBF) -> Option<(Vec<u8>, usize, usize)> {
    let path_w = wide(path);
    let factory: IShellItemImageFactory =
        SHCreateItemFromParsingName(PCWSTR(path_w.as_ptr()), None::<&IBindCtx>).ok()?;
    let bitmap = factory.GetImage(SIZE { cx: size, cy: size }, flags).ok()?;
    let handle = HGDIOBJ(bitmap.0);

    let mut info = BITMAP::default();
    if GetObjectW(handle, size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut c_void)) == 0 {
        let _ = DeleteObject(handle);
        return None;
    }
    let (width, height) = (info.bmWidth, info.bmHeight);

    let mut header = BITMAPINFO::default();
    header.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = GetDC(None);
    let rows = GetDIBits(
        hdc,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut c_void),
        &mut header,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    let _ = DeleteObject(handle);
    if rows == 0 {
        return None;
    }

    // BGRA (premultiplied) -> RGBA (straight). Some icons carry no alpha at all.
    let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
        if opaque {
            p[3] = 255;
        } else if p[3] > 0 && p[3] < 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255) / a).min(255) as u8;
            }
        }
    }
    Some((pixels, width as usize, height as usize))
}

unsafe fn icon_png(path: &str) -> Option<Vec<u8>> {
    let (pixels, width, height) = icon_pixels(path, ICON_SIZE, SIIGBF_ICONONLY)?;
    let (pixels, width, height) = tidy_icon(pixels, width, height);

    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Best);
    encoder.set_adaptive_filter(png::AdaptiveFilterType::Adaptive);
    encoder.write_header().ok()?.write_image_data(&pixels).ok()?;
    Some(out)
}

/// Box-filter downscale of a square straight-alpha RGBA image to `to` x `to` (the size must divide evenly).
fn downscale(src: &[u8], from: usize, to: usize) -> Vec<u8> {
    let k = from / to;
    let mut out = vec![0u8; to * to * 4];
    for y in 0..to {
        for x in 0..to {
            let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
            for dy in 0..k {
                for dx in 0..k {
                    let p = &src[((y * k + dy) * from + x * k + dx) * 4..][..4];
                    let alpha = p[3] as u32;
                    r += p[0] as u32 * alpha;
                    g += p[1] as u32 * alpha;
                    b += p[2] as u32 * alpha;
                    a += alpha;
                }
            }
            let o = (y * to + x) * 4;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
            }
            out[o + 3] = (a / (k * k) as u32) as u8;
        }
    }
    out
}

/// The frame is made of faint, neutral pixels: a dark outer line and white rings inside it.
fn is_frame_pixel(p: &[u8]) -> bool {
    let lightest = p[0].max(p[1]).max(p[2]);
    let darkest = p[0].min(p[1]).min(p[2]);
    p[3] >= 1 && p[3] <= 90 && (darkest >= 245 || lightest <= 10)
}

/// Cleans up what Windows returns for an icon.
///
/// * Icons with a real high-resolution image come back full size and are only scaled down to `STORED_SIZE`.
/// * Older icons only have a small (about 48 px) image. Windows centers that in a big canvas and draws a faint
///   white frame around the canvas. The frame is removed and the canvas is cropped to the artwork.
fn tidy_icon(mut px: Vec<u8>, w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let at = |x: usize, y: usize| (y * w + x) * 4;
    let top_row_framed = (0..w).filter(|&x| is_frame_pixel(&px[at(x, 0)..at(x, 0) + 4])).count() * 10 >= w * 6;

    if top_row_framed {
        let band = (w.min(h) / 24).max(3);
        for y in 0..h {
            for x in 0..w {
                // The corners blend the dark and white rings into grey, so clear every faint pixel in the band.
                if (x < band || y < band || x >= w - band || y >= h - band) && px[at(x, y) + 3] <= 90 {
                    px[at(x, y) + 3] = 0;
                }
            }
        }
    }

    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if px[at(x, y) + 3] > 8 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x1 < x0 || y1 < y0 {
        return (px, w, h);
    }

    let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
    let side = bw.max(bh);
    let fills_canvas = side * 100 >= w.min(h) * 90;
    if (top_row_framed || side * 100 < w.min(h) * 35) && !fills_canvas {
        let margin = (side * 6 / 100).max(1);
        let out = side + 2 * margin;
        let mut canvas = vec![0u8; out * out * 4];
        let (ox, oy) = (margin + (side - bw) / 2, margin + (side - bh) / 2);
        for y in 0..bh {
            for x in 0..bw {
                let from = at(x0 + x, y0 + y);
                let to = ((oy + y) * out + ox + x) * 4;
                canvas[to..to + 4].copy_from_slice(&px[from..from + 4]);
            }
        }
        return (canvas, out, out);
    }

    if w == h && w > STORED_SIZE && w % STORED_SIZE == 0 {
        return (downscale(&px, w, STORED_SIZE), STORED_SIZE, STORED_SIZE);
    }
    (px, w, h)
}

#[derive(Serialize)]
pub struct DesktopEntry {
    name: String,
    path: String,
}

unsafe fn known_folder(id: &GUID) -> Option<PathBuf> {
    let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
    let path = raw.to_string().ok().map(PathBuf::from);
    CoTaskMemFree(Some(raw.0 as *const c_void));
    path
}

fn normalize_path(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Every folder that counts as "the desktop": the user's (also when OneDrive redirects or renames it) and the shared one.
pub fn desktop_dirs() -> Vec<PathBuf> {
    // Testing aid: `SHORTCUT_LAUNCHER_DESKTOP` replaces the real desktop folders (separate paths with ';').
    if let Some(custom) = std::env::var_os("SHORTCUT_LAUNCHER_DESKTOP") {
        return std::env::split_paths(&custom).filter(|d| d.is_dir()).collect();
    }
    let mut dirs: Vec<PathBuf> = unsafe {
        [known_folder(&FOLDERID_Desktop), known_folder(&FOLDERID_PublicDesktop)].into_iter().flatten().collect()
    };
    for (var, sub) in [("USERPROFILE", "Desktop"), ("OneDrive", "Desktop"), ("PUBLIC", "Desktop")] {
        if let Ok(base) = std::env::var(var) {
            dirs.push(Path::new(&base).join(sub));
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| d.is_dir() && seen.insert(normalize_path(d)));
    dirs
}

fn collect_entries(dir: &Path, seen: &mut HashSet<String>, out: &mut Vec<DesktopEntry>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.eq_ignore_ascii_case("desktop.ini") || file_name.starts_with('.') {
            continue;
        }
        let Some(full) = path.to_str().map(str::to_owned) else { continue };
        if !seen.insert(full.to_lowercase()) {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let name = if ext == "lnk" || ext == "url" {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or(&file_name).to_owned()
        } else {
            file_name
        };
        out.push(DesktopEntry { name, path: full });
    }
}

/// Lists everything on the user's and the public desktop (files, folders and shortcuts).
pub fn desktop_shortcuts() -> Vec<DesktopEntry> {
    let (mut seen, mut entries) = (HashSet::new(), Vec::new());
    for dir in desktop_dirs() {
        collect_entries(&dir, &mut seen, &mut entries);
    }
    entries.sort_by_key(|e| e.name.to_lowercase());
    entries
}

/// Lists the files and folders directly inside `folder`.
pub fn folder_entries(folder: &str) -> Vec<DesktopEntry> {
    let (mut seen, mut entries) = (HashSet::new(), Vec::new());
    collect_entries(Path::new(folder), &mut seen, &mut entries);
    entries.sort_by_key(|e| e.name.to_lowercase());
    entries
}

/// The subset of `paths` that no longer exists.
pub fn missing_paths(paths: &[String]) -> Vec<String> {
    paths.iter().filter(|p| !Path::new(p).exists()).cloned().collect()
}

/// Looks for files by name (case-insensitive) in `folder` and up to four levels below it, shallowest match first.
/// Returns `lowercase file name -> full path` for the names that were found.
pub fn find_in_folder(folder: &str, names: &[String]) -> HashMap<String, String> {
    let wanted: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let mut found = HashMap::new();
    let mut queue = VecDeque::from([(PathBuf::from(folder), 0u8)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            visited += 1;
            if visited > 50_000 || found.len() == wanted.len() {
                return found;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if wanted.contains(&name) {
                found.entry(name).or_insert_with(|| path.to_string_lossy().into_owned());
            }
            if depth < 4 && path.is_dir() {
                queue.push_back((path, depth + 1));
            }
        }
    }
    found
}

#[derive(Deserialize)]
pub struct PlaceRequest {
    pub name: String,
    pub target: String,
    pub args: String,
}

#[derive(Serialize)]
pub struct Placed {
    pub to: String,
    /// `created` (new shortcut file), `moved`, `copied`, or `kept` (left as it was).
    pub action: String,
    pub error: Option<String>,
}

fn unique_path(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let as_path = Path::new(file_name);
    let stem = as_path.file_stem().and_then(|s| s.to_str()).unwrap_or("shortcut");
    let ext = as_path.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// A file name that Windows accepts, based on what the user called the shortcut.
fn safe_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let trimmed: String = cleaned.trim().trim_matches('.').trim().chars().take(120).collect();
    if trimmed.is_empty() { "Shortcut".into() } else { trimmed }
}

fn is_web_address(target: &str) -> bool {
    target.split_once("://").is_some_and(|(scheme, _)| {
        !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    })
}

/// Writes a `.lnk` file. Start menu and Store apps (`shell:AppsFolder\...`) get a shortcut to that exact app.
unsafe fn write_lnk(path: &Path, target: &str, args: &str) -> Result<(), String> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
    if target.starts_with("shell:") {
        let target_w = wide(target);
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(target_w.as_ptr()), None::<&IBindCtx>).map_err(|e| e.to_string())?;
        let pidl = SHGetIDListFromObject(&item).map_err(|e| e.to_string())?;
        let result = link.SetIDList(pidl);
        ILFree(Some(pidl));
        result.map_err(|e| e.to_string())?;
    } else {
        let target_w = wide(target);
        link.SetPath(PCWSTR(target_w.as_ptr())).map_err(|e| e.to_string())?;
        if let Some(dir) = Path::new(target).parent().and_then(|p| p.to_str()).filter(|p| !p.is_empty() && Path::new(target).is_file()) {
            let dir_w = wide(dir);
            let _ = link.SetWorkingDirectory(PCWSTR(dir_w.as_ptr()));
        }
        if !args.trim().is_empty() {
            let args_w = wide(args);
            link.SetArguments(PCWSTR(args_w.as_ptr())).map_err(|e| e.to_string())?;
        }
    }
    let file: IPersistFile = link.cast().map_err(|e| e.to_string())?;
    let path_w = wide(&path.to_string_lossy());
    file.Save(PCWSTR(path_w.as_ptr()), true).map_err(|e| e.to_string())
}

fn place_one(item: &PlaceRequest, dest_dir: &Path, dest_norm: &str, desktops: &HashSet<String>) -> Placed {
    let done = |to: String, action: &str| Placed { to, action: action.into(), error: None };
    let failed = |error: String| Placed { to: item.target.clone(), action: "kept".into(), error: Some(error) };
    let target = item.target.as_str();

    if is_web_address(target) {
        let to = unique_path(dest_dir, std::ffi::OsStr::new(&format!("{}.url", safe_file_stem(&item.name))));
        return match fs::write(&to, format!("[InternetShortcut]\r\nURL={target}\r\n")) {
            Ok(()) => done(to.to_string_lossy().into_owned(), "created"),
            Err(e) => failed(e.to_string()),
        };
    }

    let src = Path::new(target);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();

    // Anything that already lives in the shortcuts folder is used as it is; it never gets a second shortcut.
    if !target.starts_with("shell:") && normalize_path(src).starts_with(&format!("{dest_norm}\\")) {
        return done(target.to_owned(), "kept");
    }

    if !target.starts_with("shell:") && matches!(ext.as_str(), "lnk" | "url" | "appref-ms") && src.is_file() {
        let parent = src.parent().map(normalize_path).unwrap_or_default();
        let Some(file_name) = src.file_name() else { return failed("Invalid file name".into()) };
        let to = unique_path(dest_dir, file_name);
        let to_text = to.to_string_lossy().into_owned();
        if desktops.contains(&parent) {
            if fs::rename(src, &to).is_ok() {
                return done(to_text, "moved");
            }
            return match fs::copy(src, &to) {
                Ok(_) if fs::remove_file(src).is_ok() => done(to_text, "moved"),
                Ok(_) => done(to_text, "copied"),
                Err(e) => failed(e.to_string()),
            };
        }
        return match fs::copy(src, &to) {
            Ok(_) => done(to_text, "copied"),
            Err(e) => failed(e.to_string()),
        };
    }

    if !target.starts_with("shell:") && !src.exists() {
        return failed("The target does not exist".into());
    }
    let to = unique_path(dest_dir, std::ffi::OsStr::new(&format!("{}.lnk", safe_file_stem(&item.name))));
    match unsafe { write_lnk(&to, target, &item.args) } {
        Ok(()) => done(to.to_string_lossy().into_owned(), "created"),
        Err(e) => failed(e),
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Trashed {
    pub original: String,
    pub holding: Option<String>,
}

#[derive(Serialize)]
pub struct Restored {
    pub original: String,
    pub to: String,
    pub error: Option<String>,
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

/// Takes shortcut files (`.lnk`, `.url`) that live inside the shortcuts folder out of it and keeps them in
/// `holding_root`, so removing a shortcut in the launcher never destroys anything for good. Everything else
/// (folders, files outside the shortcuts folder, documents) is left exactly where it is.
pub fn trash_shortcut_files(folder: &str, holding_root: &Path, paths: &[String]) -> Vec<Trashed> {
    let dest_norm = normalize_path(Path::new(folder));
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let batch = holding_root.join(nanos.to_string());
    paths
        .iter()
        .map(|original| {
            let src = Path::new(original);
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let inside = normalize_path(src).starts_with(&format!("{dest_norm}\\"));
            let eligible = inside && src.is_file() && matches!(ext.as_str(), "lnk" | "url" | "appref-ms");
            let holding = if eligible {
                src.file_name().and_then(|name| {
                    fs::create_dir_all(&batch).ok()?;
                    let to = unique_path(&batch, name);
                    move_file(src, &to).ok().map(|_| to.to_string_lossy().into_owned())
                })
            } else {
                None
            };
            Trashed { original: original.clone(), holding }
        })
        .collect()
}

/// Puts files taken out by `trash_shortcut_files` back where they were.
pub fn restore_shortcut_files(items: &[Trashed]) -> Vec<Restored> {
    items
        .iter()
        .filter_map(|item| {
            let holding = Path::new(item.holding.as_ref()?);
            let original = Path::new(&item.original);
            let target = if original.exists() {
                match (original.parent(), original.file_name()) {
                    (Some(dir), Some(name)) => unique_path(dir, name),
                    _ => original.to_path_buf(),
                }
            } else {
                original.to_path_buf()
            };
            if let Some(dir) = target.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let result = move_file(holding, &target);
            if result.is_ok() {
                if let Some(batch) = holding.parent() {
                    let _ = fs::remove_dir(batch);
                }
            }
            Some(Restored {
                original: item.original.clone(),
                to: target.to_string_lossy().into_owned(),
                error: result.err().map(|e| e.to_string()),
            })
        })
        .collect()
}

/// Deletes removed shortcut files that have been kept for more than `days` days.
pub fn purge_removed(holding_root: &Path, days: u64) {
    let Ok(read) = fs::read_dir(holding_root) else { return };
    for batch in read.flatten() {
        let old = batch.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > days * 86_400);
        if old {
            let _ = fs::remove_dir_all(batch.path());
        }
    }
}

/// Real files that stand for the given shortcuts, so they can be put on the clipboard and pasted in Explorer.
/// Shortcut files (`.lnk`, `.url`) are used as they are; apps, files, folders and websites get a small
/// temporary `.lnk` or `.url`, so that pasting always gives a shortcut and never a copy of the program itself.
pub fn materialize_shortcuts(items: &[PlaceRequest]) -> Vec<String> {
    let root = std::env::temp_dir().join("ShortcutLauncher-clipboard");
    // Tidy up what earlier copies left behind.
    if let Ok(read) = fs::read_dir(&root) {
        for old in read.flatten() {
            let stale = old.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 86_400);
            if stale {
                let _ = fs::remove_dir_all(old.path());
            }
        }
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = root.join(nanos.to_string());
    let _ = fs::create_dir_all(&dir);

    unsafe {
        let com_ready = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let paths = items
            .iter()
            .filter_map(|item| {
                let target = item.target.as_str();
                let src = Path::new(target);
                let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                if !target.starts_with("shell:") && matches!(ext.as_str(), "lnk" | "url") && src.is_file() {
                    return Some(target.to_owned());
                }
                if is_web_address(target) {
                    let to = unique_path(&dir, std::ffi::OsStr::new(&format!("{}.url", safe_file_stem(&item.name))));
                    let content = format!("[InternetShortcut]
URL={target}
");
                    return fs::write(&to, content).ok().map(|_| to.to_string_lossy().into_owned());
                }
                let to = unique_path(&dir, std::ffi::OsStr::new(&format!("{}.lnk", safe_file_stem(&item.name))));
                write_lnk(&to, target, &item.args).ok().map(|_| to.to_string_lossy().into_owned())
            })
            .collect();
        if com_ready {
            CoUninitialize();
        }
        paths
    }
}

/// Puts a copy of each shortcut in one fresh folder (a drag needs all files in the same place).
pub fn stage_for_drag(items: &[PlaceRequest]) -> Result<(PathBuf, Vec<String>), String> {
    let paths = materialize_shortcuts(items);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join("ShortcutLauncher-clipboard").join(format!("drag-{nanos}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for path in paths {
        let src = Path::new(&path);
        let Some(file) = src.file_name() else { continue };
        let to = unique_path(&dir, file);
        if fs::copy(src, &to).is_ok() {
            if let Some(name) = to.file_name() {
                names.push(name.to_string_lossy().into_owned());
            }
        }
    }
    if names.is_empty() {
        return Err("There is nothing to drag".into());
    }
    Ok((dir, names))
}

/// Makes sure every added item has its shortcut file in `folder`:
/// shortcut files on the desktop are moved there, other shortcut files are copied,
/// and apps, files, folders and websites get a new `.lnk` or `.url`. Nothing is overwritten.
pub fn place_in_folder(folder: &str, items: &[PlaceRequest]) -> Vec<Placed> {
    let dest_dir = PathBuf::from(folder);
    let dest_norm = normalize_path(&dest_dir);
    let desktops: HashSet<String> = desktop_dirs().iter().map(|d| normalize_path(d)).collect();
    if !dest_dir.is_dir() {
        return items
            .iter()
            .map(|i| Placed { to: i.target.clone(), action: "kept".into(), error: Some("The shortcuts folder does not exist".into()) })
            .collect();
    }
    unsafe {
        let com_ready = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let placed = items.iter().map(|i| place_one(i, &dest_dir, &dest_norm, &desktops)).collect();
        if com_ready {
            CoUninitialize();
        }
        placed
    }
}

/// Every app in the Start menu (classic and Store apps) as JSON: [{"Name": "...", "AppID": "..."}].
pub fn start_apps() -> Result<String, String> {
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Sort-Object Name | ConvertTo-Json -Compress";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Could not read the list of installed apps".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn reg(args: &[&str]) -> bool {
    Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn autostart_enabled() -> bool {
    reg(&["query", RUN_KEY, "/v", RUN_VALUE])
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let ok = if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let value = format!("\"{}\" --hidden", exe.display());
        reg(&["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])
    } else {
        !autostart_enabled() || reg(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
    };
    if ok { Ok(()) } else { Err("Could not update the Windows startup entry".into()) }
}

/// Creates "Shortcut Launcher.lnk" on the user's desktop pointing at this executable.
pub fn create_desktop_shortcut() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = "$d=[Environment]::GetFolderPath('Desktop'); \
        $p=Join-Path $d 'Shortcut Launcher.lnk'; \
        $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); \
        $s.TargetPath=$env:SL_EXE; \
        $s.WorkingDirectory=Split-Path $env:SL_EXE; \
        $s.IconLocation=$env:SL_EXE + ',0'; \
        $s.Description='Shortcut Launcher'; \
        $s.Save(); \
        [Console]::Out.Write($p)";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("SL_EXE", &exe)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.status.success() && Path::new(&path).exists() {
        Ok(path)
    } else {
        Err("Could not create the desktop shortcut".into())
    }
}

#[cfg(test)]
mod experiments {
    use super::*;

    /// `SL_PATHS=a;b SL_OUT=dir cargo test dump_icons -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_icons() {
        let out = PathBuf::from(std::env::var("SL_OUT").expect("SL_OUT"));
        fs::create_dir_all(&out).unwrap();
        for (n, path) in std::env::var("SL_PATHS").expect("SL_PATHS").split(';').enumerate() {
            for (label, size, flags) in [
                ("s64", 64, SIIGBF_ICONONLY),
                ("s256", 256, SIIGBF_ICONONLY),
            ] {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                    if let Some((px, w, h)) = icon_pixels(path, size, flags) {
                        let file = fs::File::create(out.join(format!("{n}_{label}.png"))).unwrap();
                        let mut enc = png::Encoder::new(file, w as u32, h as u32);
                        enc.set_color(png::ColorType::Rgba);
                        enc.set_depth(png::BitDepth::Eight);
                        enc.write_header().unwrap().write_image_data(&px).unwrap();
                        println!("{n} {label}: {w}x{h} {path}");
                    } else {
                        println!("{n} {label}: FAILED {path}");
                    }
                }
            }
        }
    }
}
