//! The Windows clipboard, as Explorer uses it for files: a file list (CF_HDROP) plus a "copy" drop effect.

use std::{mem::size_of, ptr, thread, time::Duration};
use windows::{
    core::{w, BOOL},
    Win32::{
        Foundation::{HANDLE, HGLOBAL, POINT},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
            Ole::{CF_HDROP, CF_UNICODETEXT},
        },
        UI::Shell::{DragQueryFileW, DROPFILES, HDROP},
    },
};

/// Another program may have the clipboard open for a moment, so try a few times.
unsafe fn open_clipboard() -> bool {
    for _ in 0..15 {
        if OpenClipboard(None).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

unsafe fn global_from_bytes(bytes: &[u8]) -> Option<HGLOBAL> {
    let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len().max(1)).ok()?;
    let target = GlobalLock(handle);
    if target.is_null() {
        return None;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
    let _ = GlobalUnlock(handle);
    Some(handle)
}

fn utf16_bytes(text: &str, terminate: bool) -> Vec<u8> {
    text.encode_utf16().chain(terminate.then_some(0)).flat_map(u16::to_le_bytes).collect()
}

/// Puts files on the clipboard the way Explorer does, so Ctrl+V in Explorer (or on the desktop) copies them.
/// `text` is stored alongside as plain text, so pasting into a text box gives something readable.
pub fn set_files(paths: &[String], text: &str) -> Result<(), String> {
    let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, pt: POINT { x: 0, y: 0 }, fNC: BOOL(0), fWide: BOOL(1) };
    let mut files: Vec<u8> = unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, size_of::<DROPFILES>()).to_vec() };
    for path in paths {
        files.extend(utf16_bytes(path, true));
    }
    files.extend([0, 0]);

    unsafe {
        if !open_clipboard() {
            return Err("The clipboard is in use by another program. Try again.".into());
        }
        let _ = EmptyClipboard();
        let result = (|| -> Result<(), String> {
            let list = global_from_bytes(&files).ok_or("Could not prepare the file list")?;
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(list.0))).map_err(|e| e.to_string())?;

            let effect_format = RegisterClipboardFormatW(w!("Preferred DropEffect"));
            if let Some(effect) = global_from_bytes(&1u32.to_le_bytes()) {
                let _ = SetClipboardData(effect_format, Some(HANDLE(effect.0)));
            }
            if let Some(plain) = global_from_bytes(&utf16_bytes(text, true)) {
                let _ = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(plain.0)));
            }
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

/// The files currently on the clipboard (for example after Ctrl+C in Explorer).
pub fn get_files() -> Vec<String> {
    let mut files = Vec::new();
    unsafe {
        if !open_clipboard() {
            return files;
        }
        if let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) {
            let drop = HDROP(handle.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            for index in 0..count {
                let length = DragQueryFileW(drop, index, None) as usize;
                let mut buffer = vec![0u16; length + 1];
                DragQueryFileW(drop, index, Some(&mut buffer));
                files.push(String::from_utf16_lossy(&buffer[..length]));
            }
        }
        let _ = CloseClipboard();
    }
    files
}

/// Starts a real Windows drag of these files, so they can be dropped on the desktop or into any folder.
/// Only copying is allowed: the originals are never moved or deleted by the program they are dropped on.
/// All files must live in one folder. Returns when the mouse button is released.
pub fn drag_files(folder: &std::path::Path, names: &[String]) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            System::{
                Com::{CoTaskMemFree, IDataObject},
                Ole::DROPEFFECT_COPY,
            },
            UI::Shell::{Common::ITEMIDLIST, ILFindLastID, SHCreateDataObject, SHDoDragDrop, SHParseDisplayName},
        },
    };

    unsafe {
        let parse = |path: &std::path::Path| -> Option<*mut ITEMIDLIST> {
            let wide: Vec<u16> = path.to_string_lossy().encode_utf16().chain(Some(0)).collect();
            let mut pidl: *mut ITEMIDLIST = ptr::null_mut();
            (SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).is_ok() && !pidl.is_null()).then_some(pidl)
        };
        let parent = parse(folder).ok_or("Could not find the folder to drag from")?;
        let full: Vec<*mut ITEMIDLIST> = names.iter().filter_map(|n| parse(&folder.join(n))).collect();
        let children: Vec<*const ITEMIDLIST> = full.iter().map(|p| ILFindLastID(*p) as *const ITEMIDLIST).collect();
        let result = if children.is_empty() {
            Err("There is nothing to drag".to_string())
        } else {
            SHCreateDataObject::<Option<&IDataObject>, IDataObject>(Some(parent as *const ITEMIDLIST), Some(&children), None)
                .map_err(|e| e.to_string())
                .and_then(|data| SHDoDragDrop(None, &data, None, DROPEFFECT_COPY).map(|_| ()).map_err(|e| e.to_string()))
        };
        for pidl in full.into_iter().chain(Some(parent)) {
            CoTaskMemFree(Some(pidl as *const _));
        }
        result
    }
}
