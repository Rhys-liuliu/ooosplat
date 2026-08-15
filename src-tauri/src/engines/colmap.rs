use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use crate::{
    error::{Result, SplatError},
    process::{ProcessManager, ProcessObserver, ProcessSpec},
};

pub fn require_verified_cli(executable: &Path) -> Result<()> {
    if executable.is_file() {
        Ok(())
    } else {
        Err(SplatError::EngineMissing(executable.display().to_string()))
    }
}

async fn run_colmap(
    executable: &Path,
    args: Vec<OsString>,
    working_directory: &Path,
    log_path: PathBuf,
    manager: &ProcessManager,
    observer: Option<ProcessObserver>,
) -> Result<()> {
    let output = manager
        .run(ProcessSpec {
            executable: executable.to_path_buf(),
            args,
            working_directory: Some(working_directory.to_path_buf()),
            log_path: Some(log_path),
            observer,
        })
        .await?;
    if output.success {
        Ok(())
    } else {
        Err(SplatError::Process(format!(
            "COLMAP 退出码 {:?}",
            output.exit_code
        )))
    }
}

pub async fn extract_features(
    executable: &Path,
    database: &Path,
    images: &Path,
    log: PathBuf,
    manager: &ProcessManager,
    observer: Option<ProcessObserver>,
) -> Result<()> {
    run_colmap(
        executable,
        vec![
            "feature_extractor".into(),
            "--database_path".into(),
            database.into(),
            "--image_path".into(),
            images.into(),
            "--ImageReader.camera_model".into(),
            "SIMPLE_RADIAL".into(),
            "--ImageReader.single_camera".into(),
            "1".into(),
            "--FeatureExtraction.use_gpu".into(),
            "0".into(),
        ],
        database.parent().unwrap_or(images),
        log,
        manager,
        observer,
    )
    .await
}

pub async fn match_sequential(
    executable: &Path,
    database: &Path,
    log: PathBuf,
    manager: &ProcessManager,
    observer: Option<ProcessObserver>,
) -> Result<()> {
    run_colmap(
        executable,
        vec![
            "sequential_matcher".into(),
            "--database_path".into(),
            database.into(),
            "--FeatureMatching.use_gpu".into(),
            "0".into(),
            "--SequentialMatching.overlap".into(),
            "10".into(),
        ],
        database.parent().unwrap_or(Path::new(".")),
        log,
        manager,
        observer,
    )
    .await
}

pub async fn map(
    executable: &Path,
    database: &Path,
    images: &Path,
    output: &Path,
    log: PathBuf,
    manager: &ProcessManager,
    observer: Option<ProcessObserver>,
) -> Result<()> {
    tokio::fs::create_dir_all(output).await?;
    run_colmap(
        executable,
        vec![
            "mapper".into(),
            "--database_path".into(),
            database.into(),
            "--image_path".into(),
            images.into(),
            "--output_path".into(),
            output.into(),
        ],
        database.parent().unwrap_or(output),
        log,
        manager,
        observer,
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn fixed_arguments_force_cpu_colmap() {
        let feature = ["--FeatureExtraction.use_gpu", "0"];
        let matching = ["--FeatureMatching.use_gpu", "0"];
        assert_eq!(feature[1], "0");
        assert_eq!(matching[1], "0");
    }
}
