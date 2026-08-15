use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use crate::{
    error::{Result, SplatError},
    process::{ProcessManager, ProcessObserver, ProcessSpec},
    video::FramePlan,
};

pub async fn extract_uniform_frames(
    executable: &Path,
    input: &Path,
    output_directory: &Path,
    plan: &FramePlan,
    log_path: Option<PathBuf>,
    process_manager: &ProcessManager,
    observer: Option<ProcessObserver>,
) -> Result<u64> {
    if !input.is_file() {
        return Err(SplatError::InvalidPath(input.to_path_buf()));
    }
    tokio::fs::create_dir_all(output_directory).await?;
    let mut entries = tokio::fs::read_dir(output_directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let is_jpeg = entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"));
        if is_jpeg {
            return Err(SplatError::Process(
                "抽帧目录中已有 JPEG；为避免混用残缺结果，任务已停止".into(),
            ));
        }
    }

    let filter = format!(
        "fps={:.8},scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
        plan.sampling_fps,
    );
    let output_pattern = output_directory.join("frame_%06d.jpg");
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-nostats"),
        OsString::from("-y"),
        OsString::from("-i"),
        input.as_os_str().to_owned(),
        OsString::from("-vf"),
        OsString::from(filter),
        OsString::from("-q:v"),
        OsString::from("2"),
        OsString::from("-start_number"),
        OsString::from("1"),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        output_pattern.as_os_str().to_owned(),
    ];
    let output = process_manager
        .run(ProcessSpec {
            executable: executable.to_path_buf(),
            args,
            working_directory: output_directory.parent().map(Path::to_path_buf),
            log_path,
            observer,
        })
        .await?;
    if !output.success {
        return Err(SplatError::Process(format!(
            "FFmpeg 退出码 {:?}",
            output.exit_code
        )));
    }

    let mut count = 0;
    let mut entries = tokio::fs::read_dir(output_directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"))
        {
            count += 1;
        }
    }
    if count == 0 {
        return Err(SplatError::Process("FFmpeg 未输出任何画面".into()));
    }
    Ok(count)
}
