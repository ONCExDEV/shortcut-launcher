//! Durable storage for the launcher's data.
//!
//! Guarantees:
//! * Writes are atomic: data goes to a temp file, is flushed to disk, and only then replaces `data.json`.
//! * Every write is read back and verified.
//! * The previous version is always kept as `data.bak`. `backups/` holds the latest state of each of the last
//!   14 days plus a snapshot every 10 minutes (the last 24), so an accidental wipe can be rolled back.
//! * A damaged or missing `data.json` is restored from the newest valid copy and is never silently replaced.
//! * Everything that happens is appended to `launcher.log` so problems can be diagnosed.

use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const KEEP_DAILY_BACKUPS: usize = 14;
const KEEP_SNAPSHOTS: usize = 24;
const SNAPSHOT_EVERY_SECS: u64 = 600;
const MAX_LOG_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
pub struct Loaded {
    pub data: String,
    pub notice: Option<String>,
}

pub struct Store {
    dir: PathBuf,
}

fn strip_bom(raw: &str) -> &str {
    raw.trim_start_matches('\u{feff}')
}

/// Valid means: parses as JSON and has a `groups` array.
fn is_valid(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(strip_bom(raw))
        .ok()
        .and_then(|v| v.get("groups").map(|g| g.is_array()))
        .unwrap_or(false)
}

fn summary(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(strip_bom(raw)) else { return "unreadable".into() };
    let groups = v.get("groups").and_then(|g| g.as_array()).cloned().unwrap_or_default();
    let items: usize = groups.iter().map(|g| g.get("items").and_then(|i| i.as_array()).map_or(0, |i| i.len())).sum();
    format!("{} groups, {} shortcuts", groups.len(), items)
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| strip_bom(&s).to_owned())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `YYYY-MM-DD` (UTC) from a unix timestamp.
fn date_string(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(dir.join("backups")).map_err(|e| format!("Could not create the data folder: {e}"))?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn main_file(&self) -> PathBuf {
        self.dir.join("data.json")
    }

    pub fn log(&self, message: &str) {
        let path = self.dir.join("launcher.log");
        if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
            let _ = fs::rename(&path, self.dir.join("launcher.log.old"));
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[{} {}s] {message}", date_string(now_secs()), now_secs() % 86_400);
        }
    }

    /// `data.bak` first, then every file in `backups/` from newest to oldest.
    fn backup_candidates(&self) -> Vec<PathBuf> {
        let mut files: Vec<(SystemTime, PathBuf)> = fs::read_dir(self.dir.join("backups"))
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "json"))
                    .map(|p| (fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), p))
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut all = vec![self.dir.join("data.bak")];
        all.extend(files.into_iter().map(|(_, p)| p));
        all
    }

    pub fn load(&self) -> Loaded {
        let main = self.main_file();
        if let Some(raw) = read_text(&main) {
            if is_valid(&raw) {
                self.log(&format!("load: data.json ok ({})", summary(&raw)));
                return Loaded { data: raw, notice: None };
            }
        }

        let existed = main.exists();
        for candidate in self.backup_candidates() {
            let Some(raw) = read_text(&candidate) else { continue };
            if !is_valid(&raw) {
                continue;
            }
            let name = candidate.file_name().and_then(|n| n.to_str()).unwrap_or("a backup").to_owned();
            if existed {
                let _ = fs::rename(&main, self.dir.join(format!("data.damaged-{}.json", now_secs())));
            }
            let _ = fs::write(&main, &raw);
            self.log(&format!("load: data.json {} -> restored from {name} ({})", if existed { "damaged" } else { "missing" }, summary(&raw)));
            return Loaded {
                data: raw,
                notice: Some(format!("Your data file was {}, so it was restored from {name}.", if existed { "damaged" } else { "missing" })),
            };
        }

        if existed {
            let kept = format!("data.damaged-{}.json", now_secs());
            let _ = fs::rename(&main, self.dir.join(&kept));
            self.log(&format!("load: data.json damaged and no backup found; kept as {kept}"));
            return Loaded {
                data: String::new(),
                notice: Some(format!("Your data file could not be read and no backup was found. The damaged file was kept as {kept} in the data folder.")),
            };
        }

        self.log("load: no data yet (first run)");
        Loaded { data: String::new(), notice: None }
    }

    pub fn save(&self, json: &str) -> Result<(), String> {
        if !is_valid(json) {
            self.log("save: refused, data is not valid");
            return Err("Refusing to save data that is not valid".into());
        }

        let main = self.main_file();
        let tmp = self.dir.join("data.json.tmp");
        {
            let mut file = File::create(&tmp).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
            file.write_all(json.as_bytes()).map_err(|e| format!("Could not write data: {e}"))?;
            file.sync_all().map_err(|e| format!("Could not flush data to disk: {e}"))?;
        }

        if let Some(previous) = read_text(&main) {
            if is_valid(&previous) {
                let _ = fs::write(self.dir.join("data.bak"), &previous);
                let backups = self.dir.join("backups");
                let _ = fs::write(backups.join(format!("data-{}.json", date_string(now_secs()))), &previous);
                if self.newest_snapshot_age().map_or(true, |age| age >= SNAPSHOT_EVERY_SECS) {
                    let _ = fs::write(backups.join(format!("snap-{}.json", now_secs())), &previous);
                    self.prune();
                }
            }
        }

        // Replacing a file can fail briefly if something (an antivirus scanner, say) has it open.
        let mut last_error = String::new();
        for attempt in 0..5 {
            match fs::rename(&tmp, &main) {
                Ok(()) => {
                    last_error.clear();
                    break;
                }
                Err(e) => {
                    last_error = e.to_string();
                    std::thread::sleep(std::time::Duration::from_millis(60 * (attempt + 1)));
                }
            }
        }
        if !last_error.is_empty() {
            self.log(&format!("save: could not replace data.json: {last_error}"));
            return Err(format!("Could not replace the data file: {last_error}"));
        }

        match read_text(&main) {
            Some(written) if written == strip_bom(json) => {
                self.log(&format!("save: ok ({})", summary(json)));
                Ok(())
            }
            _ => {
                self.log("save: verification failed, data on disk differs from what was written");
                Err("The saved file did not match what was written".into())
            }
        }
    }

    fn files_with_prefix(&self, prefix: &str) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(self.dir.join("backups"))
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix))).collect())
            .unwrap_or_default();
        files.sort();
        files.reverse();
        files
    }

    fn newest_snapshot_age(&self) -> Option<u64> {
        let newest = self.files_with_prefix("snap-").into_iter().next()?;
        let secs: u64 = newest.file_stem()?.to_str()?.trim_start_matches("snap-").parse().ok()?;
        Some(now_secs().saturating_sub(secs))
    }

    fn prune(&self) {
        for old in self.files_with_prefix("data-20").into_iter().skip(KEEP_DAILY_BACKUPS) {
            let _ = fs::remove_file(old);
        }
        for old in self.files_with_prefix("snap-").into_iter().skip(KEEP_SNAPSHOTS) {
            let _ = fs::remove_file(old);
        }
    }

    pub fn export(&self, to: &Path) -> Result<(), String> {
        let raw = read_text(&self.main_file()).filter(|r| is_valid(r)).ok_or("There is no saved data to export yet")?;
        fs::write(to, raw).map_err(|e| format!("Could not write the backup file: {e}"))?;
        self.log(&format!("export: wrote {}", to.display()));
        Ok(())
    }

    pub fn import(&self, from: &Path) -> Result<String, String> {
        let raw = read_text(from).ok_or("Could not read that file")?;
        if !is_valid(&raw) {
            return Err("That file is not a Shortcut Launcher backup".into());
        }
        if let Some(current) = read_text(&self.main_file()).filter(|c| is_valid(c)) {
            let _ = fs::write(self.dir.join("backups").join(format!("before-import-{}.json", now_secs())), current);
        }
        self.save(&raw)?;
        self.log(&format!("import: restored from {} ({})", from.display(), summary(&raw)));
        Ok(raw)
    }
}
