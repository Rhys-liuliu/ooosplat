use std::{fs::File, io::Read, path::Path};

use crate::error::{Result, SplatError};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlyInfo {
    pub file_size: u64,
    pub splat_count: u64,
}

pub fn inspect_gaussian_ply(path: &Path) -> Result<PlyInfo> {
    let size = path.metadata()?.len();
    if size == 0 {
        return Err(SplatError::Process("Brush 输出的 PLY 为空".into()));
    }
    let mut file = File::open(path)?;
    let mut bytes = vec![0_u8; (size.min(256 * 1024)) as usize];
    let read = file.read(&mut bytes)?;
    let header = String::from_utf8_lossy(&bytes[..read]);
    let end = header
        .find("end_header")
        .ok_or_else(|| SplatError::Process("PLY 缺少 end_header".into()))?;
    let header = &header[..end];
    if !header.starts_with("ply\n") && !header.starts_with("ply\r\n") {
        return Err(SplatError::Process("输出不是合法 PLY 文件".into()));
    }
    let splat_count = header
        .lines()
        .find_map(|line| line.strip_prefix("element vertex "))
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if splat_count == 0 {
        return Err(SplatError::Process("PLY 不包含 Gaussian 顶点".into()));
    }
    for property in [
        " x", " y", " z", " f_dc_0", " opacity", " scale_0", " rot_0",
    ] {
        if !header
            .lines()
            .any(|line| line.starts_with("property ") && line.ends_with(property))
        {
            return Err(SplatError::Process(format!(
                "PLY 缺少 Gaussian 属性：{}",
                property.trim()
            )));
        }
    }
    Ok(PlyInfo {
        file_size: size,
        splat_count,
    })
}

pub fn validate_gaussian_ply(path: &Path) -> Result<u64> {
    Ok(inspect_gaussian_ply(path)?.file_size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_splat_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("valid.ply");
        std::fs::write(&path, b"ply\nformat binary_little_endian 1.0\nelement vertex 42\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float opacity\nproperty float scale_0\nproperty float rot_0\nend_header\n").unwrap();
        assert_eq!(inspect_gaussian_ply(&path).unwrap().splat_count, 42);
    }
    #[test]
    fn rejects_plain_point_cloud() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.ply");
        std::fs::write(&path, b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n").unwrap();
        assert!(inspect_gaussian_ply(&path).is_err());
    }
}
