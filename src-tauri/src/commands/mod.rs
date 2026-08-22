use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    engines::{
        ffprobe::probe_video, health::check_colmap_acceleration as detect_colmap_acceleration,
        ColmapAccelerationStatus, EnginePaths, EngineStatus,
    },
    error::{Result, SplatError},
    pipeline::runner::{PipelineResult, PipelineRunner},
    presets::Quality,
    project::{
        catalog::{self, AppSettings, ProjectOverview},
        manager::atomic_write_json,
        GaussianTransform, ProjectStatus,
    },
    reconstruction::{ply::inspect_gaussian_ply, splat_transform::export_transformed_ply},
    video::{FramePlan, FrameSelectionStrategy, UniformRatioFrameSelection, VideoInfo},
};

#[derive(Default)]
pub struct PipelineController {
    active: Mutex<Option<Arc<PipelineRunner>>>,
}

#[derive(Default)]
pub struct PreviewController {
    active: Mutex<Option<(Uuid, PathBuf)>>,
    metadata_write: Mutex<()>,
    export: Mutex<()>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaussianPreviewDescriptor {
    project_id: Uuid,
    model_path: PathBuf,
    format: &'static str,
    file_size: u64,
    splat_count: u64,
    transform: GaussianTransform,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaussianExportProgress {
    project_id: Uuid,
    processed_splats: u64,
    total_splats: u64,
    progress: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GaussianExportResult {
    path: PathBuf,
    file_size: u64,
    splat_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAndPlan {
    video: VideoInfo,
    plan: FramePlan,
}

fn paths_for_app(app: &tauri::AppHandle) -> EnginePaths {
    EnginePaths::discover(app.path().resource_dir().ok().as_deref())
}

#[tauri::command]
pub async fn check_engines(app: tauri::AppHandle) -> Vec<EngineStatus> {
    paths_for_app(&app).check_all().await
}

#[tauri::command]
pub async fn check_colmap_acceleration(app: tauri::AppHandle) -> ColmapAccelerationStatus {
    detect_colmap_acceleration(&paths_for_app(&app)).await
}

#[tauri::command]
pub async fn probe_and_plan(
    app: tauri::AppHandle,
    path: String,
    quality: Quality,
) -> std::result::Result<ProbeAndPlan, SplatError> {
    let video = probe_video(&paths_for_app(&app).ffprobe, &PathBuf::from(path), None).await?;
    let plan = UniformRatioFrameSelection.create_plan(&video, &quality.preset());
    Ok(ProbeAndPlan { video, plan })
}

#[tauri::command]
pub async fn get_project_overview(
    state: State<'_, PipelineController>,
) -> std::result::Result<ProjectOverview, SplatError> {
    let mut overview = catalog::get_overview().await?;
    if state.active.lock().await.is_none() {
        for project in &mut overview.projects {
            if project.status == ProjectStatus::Running {
                project.status = ProjectStatus::Interrupted;
            }
        }
    }
    Ok(overview)
}

#[tauri::command]
pub async fn set_projects_root(
    projects_root: String,
) -> std::result::Result<AppSettings, SplatError> {
    catalog::save_projects_root(PathBuf::from(projects_root)).await
}

#[tauri::command]
pub async fn start_pipeline(
    app: tauri::AppHandle,
    state: State<'_, PipelineController>,
    path: String,
    quality: Quality,
    projects_root: String,
) -> std::result::Result<PipelineResult, SplatError> {
    let emitter = app.clone();
    let started = Instant::now();
    let runner = Arc::new(PipelineRunner::new(paths_for_app(&app), move |event| {
        let _ = emitter.emit("pipeline-event", event);
    }));
    {
        let mut active = state.active.lock().await;
        if active.is_some() {
            return Err(SplatError::Process("已有任务正在运行".into()));
        }
        *active = Some(runner.clone());
    }
    let result = runner
        .generate(Path::new(&path), quality, Path::new(&projects_root))
        .await;
    if let Err(error) = &result {
        let stage = if matches!(error, SplatError::Cancelled) {
            crate::pipeline::PipelineStage::Cancelled
        } else {
            crate::pipeline::PipelineStage::Failed
        };
        let mut event = crate::pipeline::PipelineEvent::mapped(stage, 1.0, error.to_string());
        event.elapsed_ms = started.elapsed().as_millis() as u64;
        let _ = app.emit("pipeline-event", event);
    }
    *state.active.lock().await = None;
    result
}

#[tauri::command]
pub async fn cancel_pipeline(state: State<'_, PipelineController>) -> Result<()> {
    if let Some(runner) = state.active.lock().await.as_ref() {
        runner.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_project(
    app: tauri::AppHandle,
    state: State<'_, PipelineController>,
    preview: State<'_, PreviewController>,
    project_id: String,
) -> Result<()> {
    if state.active.lock().await.is_some() {
        return Err(SplatError::Process("任务运行期间不能删除项目".into()));
    }
    let id =
        Uuid::parse_str(&project_id).map_err(|_| SplatError::Process("项目 ID 无效".into()))?;
    let mut active = preview.active.lock().await;
    if active
        .as_ref()
        .is_some_and(|(active_id, _)| *active_id == id)
    {
        if let Some((_, path)) = active.take() {
            let _ = app.asset_protocol_scope().forbid_file(path);
        }
    }
    drop(active);
    catalog::delete_project(id).await
}

fn parse_project_id(project_id: &str) -> Result<Uuid> {
    Uuid::parse_str(project_id).map_err(|_| SplatError::Process("项目 ID 无效".into()))
}

#[tauri::command]
pub async fn prepare_gaussian_preview(
    app: tauri::AppHandle,
    state: State<'_, PreviewController>,
    project_id: String,
) -> Result<GaussianPreviewDescriptor> {
    let id = parse_project_id(&project_id)?;
    let (_, path, metadata) = catalog::registered_final_ply_for_project(id).await?;
    let info = inspect_gaussian_ply(&path)?;
    let transform = metadata.transform.validate()?;

    let mut active = state.active.lock().await;
    if let Some((previous_id, previous_path)) = active.as_ref() {
        if *previous_id != id {
            let _ = app.asset_protocol_scope().forbid_file(previous_path);
        }
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| SplatError::Process(format!("无法开放本地 PLY 预览资源：{error}")))?;
    *active = Some((id, path.clone()));

    Ok(GaussianPreviewDescriptor {
        project_id: id,
        model_path: path,
        format: "ply",
        file_size: info.file_size,
        splat_count: info.splat_count,
        transform,
    })
}

#[tauri::command]
pub async fn release_gaussian_preview(
    app: tauri::AppHandle,
    state: State<'_, PreviewController>,
    project_id: String,
) -> Result<()> {
    let id = parse_project_id(&project_id)?;
    let mut active = state.active.lock().await;
    if active
        .as_ref()
        .is_some_and(|(active_id, _)| *active_id == id)
    {
        if let Some((_, path)) = active.take() {
            let _ = app.asset_protocol_scope().forbid_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_gaussian_transform(
    state: State<'_, PreviewController>,
    project_id: String,
    transform: GaussianTransform,
) -> Result<GaussianTransform> {
    let id = parse_project_id(&project_id)?;
    let transform = transform.validate()?;
    let _write_guard = state.metadata_write.lock().await;
    let (root, _, mut metadata) = catalog::registered_final_ply_for_project(id).await?;
    metadata.schema_version = crate::project::metadata::schema_version();
    metadata.model = "final.ply".into();
    metadata.transform = transform;
    atomic_write_json(&root.join("project.json"), &metadata).await?;
    Ok(transform)
}

#[tauri::command]
pub async fn export_transformed_gaussian(
    app: tauri::AppHandle,
    state: State<'_, PreviewController>,
    project_id: String,
    transform: GaussianTransform,
) -> Result<GaussianExportResult> {
    let id = parse_project_id(&project_id)?;
    let transform = transform.validate()?;
    let _export_guard = state.export.lock().await;
    let (root, source, _) = catalog::registered_final_ply_for_project(id).await?;
    let emitter = app.clone();
    let (path, info) = tokio::task::spawn_blocking(move || {
        export_transformed_ply(&source, &root, transform, |processed, total| {
            let _ = emitter.emit(
                "gaussian-export-progress",
                GaussianExportProgress {
                    project_id: id,
                    processed_splats: processed,
                    total_splats: total,
                    progress: if total == 0 {
                        0.0
                    } else {
                        processed as f64 / total as f64 * 100.0
                    },
                },
            );
        })
    })
    .await
    .map_err(|error| SplatError::Process(format!("Gaussian 导出线程失败：{error}")))??;
    Ok(GaussianExportResult {
        path,
        file_size: info.file_size,
        splat_count: info.splat_count,
    })
}

#[tauri::command]
pub async fn export_ply(source_path: String, destination_path: String) -> Result<u64> {
    let source = catalog::validate_registered_final_ply(Path::new(&source_path)).await?;
    let destination = PathBuf::from(destination_path);
    if destination
        .extension()
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("ply"))
    {
        return Err(SplatError::InvalidPath(destination));
    }
    Ok(tokio::fs::copy(source, destination).await?)
}
