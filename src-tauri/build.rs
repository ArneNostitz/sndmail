fn main() {
  // Cargo checks this package before the beforeBuildCommand has compiled the
  // bundled helper. Keep a placeholder app bundle for Tauri resource validation;
  // prepare-mail-worker.mjs replaces it with the signed helper before packaging.
  // Generated binaries are ignored by Git.
  let helper = std::path::Path::new("binaries/SndmailWorker.app/Contents/MacOS/sndmail-worker");
  if !helper.exists() {
    std::fs::create_dir_all(helper.parent().expect("helper has parent directory"))
      .expect("create helper resource directory");
    std::fs::write(helper, b"mail worker pending native build\n")
      .expect("create helper resource placeholder");
    std::fs::write(
      "binaries/SndmailWorker.app/Contents/Info.plist",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>sndmail-worker</string><key>CFBundleIdentifier</key><string>com.anydaysomething.sndmail.worker</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>",
    ).expect("create helper app bundle placeholder metadata");
  }
  tauri_build::build()
}
