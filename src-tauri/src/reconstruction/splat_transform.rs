//! Streaming, non-destructive transform export for Brush Gaussian PLY files.
//!
//! SH rotation follows the MIT-licensed PlayCanvas splat-transform implementation.

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::{
    error::{Result, SplatError},
    project::GaussianTransform,
    reconstruction::ply::{inspect_gaussian_ply, PlyInfo},
};

const MAX_HEADER_BYTES: usize = 1024 * 1024;
const ROWS_PER_CHUNK: usize = 4096;

#[derive(Debug)]
struct PlyLayout {
    header: Vec<u8>,
    count: u64,
    stride: usize,
    offsets: HashMap<String, usize>,
    rest_count: usize,
}

#[derive(Debug, Clone, Copy)]
struct Quaternion {
    x: f64,
    y: f64,
    z: f64,
    w: f64,
}

impl Quaternion {
    fn from_euler_degrees([ex, ey, ez]: [f64; 3]) -> Self {
        let half_to_rad = 0.5 * std::f64::consts::PI / 180.0;
        let (sx, cx) = (ex * half_to_rad).sin_cos();
        let (sy, cy) = (ey * half_to_rad).sin_cos();
        let (sz, cz) = (ez * half_to_rad).sin_cos();
        Self {
            x: sx * cy * cz - cx * sy * sz,
            y: cx * sy * cz + sx * cy * sz,
            z: cx * cy * sz - sx * sy * cz,
            w: cx * cy * cz + sx * sy * sz,
        }
        .normalized()
    }

    fn normalized(self) -> Self {
        let length = (self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w).sqrt();
        if length <= f64::EPSILON || !length.is_finite() {
            Self {
                x: 0.0,
                y: 0.0,
                z: 0.0,
                w: 1.0,
            }
        } else {
            Self {
                x: self.x / length,
                y: self.y / length,
                z: self.z / length,
                w: self.w / length,
            }
        }
    }

    fn mul(self, rhs: Self) -> Self {
        Self {
            x: self.w * rhs.x + self.x * rhs.w + self.y * rhs.z - self.z * rhs.y,
            y: self.w * rhs.y + self.y * rhs.w + self.z * rhs.x - self.x * rhs.z,
            z: self.w * rhs.z + self.z * rhs.w + self.x * rhs.y - self.y * rhs.x,
            w: self.w * rhs.w - self.x * rhs.x - self.y * rhs.y - self.z * rhs.z,
        }
        .normalized()
    }

    fn transform_point(self, [x, y, z]: [f64; 3]) -> [f64; 3] {
        let ix = self.w * x + self.y * z - self.z * y;
        let iy = self.w * y + self.z * x - self.x * z;
        let iz = self.w * z + self.x * y - self.y * x;
        let iw = -self.x * x - self.y * y - self.z * z;
        [
            ix * self.w + iw * -self.x + iy * -self.z - iz * -self.y,
            iy * self.w + iw * -self.y + iz * -self.x - ix * -self.z,
            iz * self.w + iw * -self.z + ix * -self.y - iy * -self.x,
        ]
    }

    fn matrix(self) -> [f64; 9] {
        let x2 = self.x + self.x;
        let y2 = self.y + self.y;
        let z2 = self.z + self.z;
        let xx = self.x * x2;
        let xy = self.x * y2;
        let xz = self.x * z2;
        let yy = self.y * y2;
        let yz = self.y * z2;
        let zz = self.z * z2;
        let wx = self.w * x2;
        let wy = self.w * y2;
        let wz = self.w * z2;
        [
            1.0 - (yy + zz),
            xy + wz,
            xz - wy,
            xy - wz,
            1.0 - (xx + zz),
            yz + wx,
            xz + wy,
            yz - wx,
            1.0 - (xx + yy),
        ]
    }
}

fn unsupported(detail: impl Into<String>) -> SplatError {
    SplatError::Process(format!(
        "第一阶段仅支持 OOOSplat/Brush binary_little_endian Gaussian PLY：{}",
        detail.into()
    ))
}

fn parse_layout(reader: &mut BufReader<File>) -> Result<PlyLayout> {
    let mut header = Vec::new();
    let mut line = Vec::new();
    let mut format_ok = false;
    let mut vertex_seen = false;
    let mut in_vertex = false;
    let mut data_element_seen = false;
    let mut count = 0_u64;
    let mut stride = 0_usize;
    let mut offsets = HashMap::new();

    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Err(unsupported("PLY header 未完整结束"));
        }
        header.extend_from_slice(&line);
        if header.len() > MAX_HEADER_BYTES {
            return Err(unsupported("PLY header 超过 1 MB"));
        }
        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        if header.len() == line.len() && trimmed != "ply" {
            return Err(unsupported("缺少 ply 文件标识"));
        }
        if trimmed == "format binary_little_endian 1.0" {
            format_ok = true;
        } else if let Some(rest) = trimmed.strip_prefix("element ") {
            let mut parts = rest.split_whitespace();
            let name = parts.next().unwrap_or_default();
            let element_count = parts
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| unsupported("element 数量无效"))?;
            in_vertex = name == "vertex";
            if in_vertex {
                if data_element_seen {
                    return Err(unsupported("vertex 必须是第一个数据元素"));
                }
                vertex_seen = true;
                count = element_count;
            }
            if element_count > 0 {
                data_element_seen = true;
            }
        } else if trimmed.starts_with("property ") && in_vertex {
            let parts = trimmed.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 3 || !matches!(parts[1], "float" | "float32") {
                return Err(unsupported("vertex 只支持标量 float32 属性"));
            }
            if offsets.insert(parts[2].to_string(), stride).is_some() {
                return Err(unsupported("vertex 包含重复属性"));
            }
            stride += 4;
        }
        if trimmed == "end_header" {
            break;
        }
    }

    if !format_ok || !vertex_seen || count == 0 || stride == 0 {
        return Err(unsupported("格式、vertex 数量或属性布局无效"));
    }
    for name in [
        "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3",
    ] {
        if !offsets.contains_key(name) {
            return Err(unsupported(format!("缺少 {name} 属性")));
        }
    }
    let rest_count = (0..)
        .take_while(|index| offsets.contains_key(&format!("f_rest_{index}")))
        .count();
    if !matches!(rest_count, 0 | 9 | 24 | 45) {
        return Err(unsupported("f_rest 属性必须完整对应 SH degree 0–3"));
    }
    if offsets.keys().any(|name| {
        name.strip_prefix("f_rest_")
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|index| index >= rest_count)
    }) {
        return Err(unsupported("f_rest 属性编号不连续"));
    }

    Ok(PlyLayout {
        header,
        count,
        stride,
        offsets,
        rest_count,
    })
}

fn read_float(row: &[u8], offset: usize) -> f64 {
    f32::from_le_bytes(row[offset..offset + 4].try_into().expect("float slice")) as f64
}

fn write_float(row: &mut [u8], offset: usize, value: f64) {
    row[offset..offset + 4].copy_from_slice(&(value as f32).to_le_bytes());
}

fn transform_row(
    row: &mut [u8],
    layout: &PlyLayout,
    transform: GaussianTransform,
    rotation: Quaternion,
    sh_rotation: &ShRotation,
) -> Result<()> {
    let offset = |name: &str| *layout.offsets.get(name).expect("validated property");
    let source = [
        read_float(row, offset("x")) * transform.scale,
        read_float(row, offset("y")) * transform.scale,
        read_float(row, offset("z")) * transform.scale,
    ];
    let point = rotation.transform_point(source);
    for (name, value, translation) in [
        ("x", point[0], transform.position[0]),
        ("y", point[1], transform.position[1]),
        ("z", point[2], transform.position[2]),
    ] {
        let result = value + translation;
        if !result.is_finite() {
            return Err(unsupported("Transform 导致 position 溢出"));
        }
        write_float(row, offset(name), result);
    }

    let gaussian = Quaternion {
        w: read_float(row, offset("rot_0")),
        x: read_float(row, offset("rot_1")),
        y: read_float(row, offset("rot_2")),
        z: read_float(row, offset("rot_3")),
    };
    let composed = rotation.mul(gaussian);
    for (name, value) in [
        ("rot_0", composed.w),
        ("rot_1", composed.x),
        ("rot_2", composed.y),
        ("rot_3", composed.z),
    ] {
        write_float(row, offset(name), value);
    }

    let log_scale = transform.scale.ln();
    for name in ["scale_0", "scale_1", "scale_2"] {
        write_float(row, offset(name), read_float(row, offset(name)) + log_scale);
    }

    if layout.rest_count > 0 {
        let per_channel = layout.rest_count / 3;
        let mut source = vec![0.0_f64; per_channel];
        for channel in 0..3 {
            for (coefficient, value) in source.iter_mut().enumerate() {
                *value = read_float(
                    row,
                    offset(&format!("f_rest_{}", channel * per_channel + coefficient)),
                );
            }
            let result = sh_rotation.apply(&source);
            for (coefficient, value) in result.into_iter().enumerate() {
                write_float(
                    row,
                    offset(&format!("f_rest_{}", channel * per_channel + coefficient)),
                    value,
                );
            }
        }
    }
    Ok(())
}

pub fn export_transformed_ply(
    source: &Path,
    project_root: &Path,
    transform: GaussianTransform,
    mut progress: impl FnMut(u64, u64),
) -> Result<(PathBuf, PlyInfo)> {
    let transform = transform.validate()?;
    let source = std::fs::canonicalize(source)?;
    let mut reader = BufReader::new(File::open(&source)?);
    let layout = parse_layout(&mut reader)?;
    let rotation = Quaternion::from_euler_degrees(transform.rotation);
    let sh_rotation = ShRotation::new(rotation.matrix());

    let output = (1_u32..10_000)
        .map(|suffix| {
            if suffix == 1 {
                project_root.join("edited.ply")
            } else {
                project_root.join(format!("edited-{suffix}.ply"))
            }
        })
        .find(|candidate| !candidate.exists())
        .ok_or_else(|| SplatError::Process("项目中已存在过多 edited PLY 文件".into()))?;
    let temporary = project_root.join(format!(".edited-{}.ply.tmp", Uuid::new_v4()));

    let result = (|| -> Result<()> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&layout.header)?;
        let mut rows_done = 0_u64;
        let mut chunk = vec![0_u8; layout.stride * ROWS_PER_CHUNK];
        while rows_done < layout.count {
            let rows = ((layout.count - rows_done) as usize).min(ROWS_PER_CHUNK);
            let bytes = rows * layout.stride;
            reader.read_exact(&mut chunk[..bytes])?;
            for row in chunk[..bytes].chunks_exact_mut(layout.stride) {
                transform_row(row, &layout, transform, rotation, &sh_rotation)?;
            }
            writer.write_all(&chunk[..bytes])?;
            rows_done += rows as u64;
            progress(rows_done, layout.count);
        }
        std::io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        std::fs::rename(&temporary, &output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }

    let info = inspect_gaussian_ply(&output)?;
    if info.splat_count != layout.count {
        let _ = std::fs::remove_file(&output);
        return Err(SplatError::Process("导出 PLY 的 Splat 数量校验失败".into()));
    }
    Ok((output, info))
}

// PlayCanvas uses real SH coefficients grouped by channel and by bands of 3, 5 and 7.
struct ShRotation {
    band1: [[f64; 3]; 3],
    band2: [[f64; 5]; 5],
    band3: [[f64; 7]; 7],
}

impl ShRotation {
    fn new(rot: [f64; 9]) -> Self {
        let band1 = [
            [rot[4], -rot[7], rot[1]],
            [-rot[5], rot[8], -rot[2]],
            [rot[3], -rot[6], rot[0]],
        ];
        let band2 = build_band2(&band1);
        let band3 = build_band3(&band1, &band2);
        Self {
            band1,
            band2,
            band3,
        }
    }

    fn apply(&self, source: &[f64]) -> Vec<f64> {
        let mut result = source.to_vec();
        if source.len() >= 3 {
            multiply_band(&mut result[0..3], &source[0..3], &self.band1);
        }
        if source.len() >= 8 {
            multiply_band(&mut result[3..8], &source[3..8], &self.band2);
        }
        if source.len() >= 15 {
            multiply_band(&mut result[8..15], &source[8..15], &self.band3);
        }
        result
    }
}

fn multiply_band<const N: usize>(result: &mut [f64], source: &[f64], matrix: &[[f64; N]; N]) {
    for row in 0..N {
        result[row] = (0..N)
            .map(|column| source[column] * matrix[row][column])
            .sum();
    }
}

fn build_band2(s: &[[f64; 3]; 3]) -> [[f64; 5]; 5] {
    let q = |a: f64, b: f64, c: f64, d: f64| 0.5 * (a * b + c * d + b * a + d * c);
    let r3_4 = (3.0_f64 / 4.0).sqrt();
    let r1_3 = (1.0_f64 / 3.0).sqrt();
    let r4_3 = (4.0_f64 / 3.0).sqrt();
    let r1_4 = 0.5_f64;
    [
        [
            q(s[2][2], s[0][0], s[2][0], s[0][2]),
            s[2][1] * s[0][0] + s[0][1] * s[2][0],
            r3_4 * 2.0 * s[2][1] * s[0][1],
            s[2][1] * s[0][2] + s[0][1] * s[2][2],
            r1_4 * 2.0 * (s[2][2] * s[0][2] - s[2][0] * s[0][0]),
        ],
        [
            q(s[1][2], s[0][0], s[1][0], s[0][2]),
            s[1][1] * s[0][0] + s[0][1] * s[1][0],
            r3_4 * 2.0 * s[1][1] * s[0][1],
            s[1][1] * s[0][2] + s[0][1] * s[1][2],
            r1_4 * 2.0 * (s[1][2] * s[0][2] - s[1][0] * s[0][0]),
        ],
        [
            r1_3 * 2.0 * s[1][2] * s[1][0]
                - (1.0_f64 / 12.0).sqrt() * 2.0 * (s[2][2] * s[2][0] + s[0][2] * s[0][0]),
            r4_3 * s[1][1] * s[1][0] - r1_3 * (s[2][1] * s[2][0] + s[0][1] * s[0][0]),
            s[1][1] * s[1][1] - r1_4 * (s[2][1] * s[2][1] + s[0][1] * s[0][1]),
            r4_3 * s[1][1] * s[1][2] - r1_3 * (s[2][1] * s[2][2] + s[0][1] * s[0][2]),
            r1_3 * (s[1][2] * s[1][2] - s[1][0] * s[1][0])
                - (1.0_f64 / 12.0).sqrt()
                    * (s[2][2] * s[2][2] - s[2][0] * s[2][0] + s[0][2] * s[0][2]
                        - s[0][0] * s[0][0]),
        ],
        [
            q(s[1][2], s[2][0], s[1][0], s[2][2]),
            s[1][1] * s[2][0] + s[2][1] * s[1][0],
            r3_4 * 2.0 * s[1][1] * s[2][1],
            s[1][1] * s[2][2] + s[2][1] * s[1][2],
            r1_4 * 2.0 * (s[1][2] * s[2][2] - s[1][0] * s[2][0]),
        ],
        [
            r1_4 * 2.0 * (s[2][2] * s[2][0] - s[0][2] * s[0][0]),
            s[2][1] * s[2][0] - s[0][1] * s[0][0],
            r3_4 * (s[2][1] * s[2][1] - s[0][1] * s[0][1]),
            s[2][1] * s[2][2] - s[0][1] * s[0][2],
            r1_4 * (s[2][2] * s[2][2] - s[2][0] * s[2][0] - s[0][2] * s[0][2] + s[0][0] * s[0][0]),
        ],
    ]
}

fn build_band3(s: &[[f64; 3]; 3], b: &[[f64; 5]; 5]) -> [[f64; 7]; 7] {
    // The expressions below are the real-SH recurrence used by PlayCanvas splat-transform.
    let a = |n: f64, d: f64| (n / d).sqrt();
    [
        [
            0.5 * ((s[2][2] * b[0][0] + s[2][0] * b[0][4])
                + (s[0][2] * b[4][0] + s[0][0] * b[4][4])),
            a(3.0, 2.0) * (s[2][1] * b[0][0] + s[0][1] * b[4][0]),
            a(15.0, 16.0) * (s[2][1] * b[0][1] + s[0][1] * b[4][1]),
            a(5.0, 6.0) * (s[2][1] * b[0][2] + s[0][1] * b[4][2]),
            a(15.0, 16.0) * (s[2][1] * b[0][3] + s[0][1] * b[4][3]),
            a(3.0, 2.0) * (s[2][1] * b[0][4] + s[0][1] * b[4][4]),
            0.5 * ((s[2][2] * b[0][4] - s[2][0] * b[0][0])
                + (s[0][2] * b[4][4] - s[0][0] * b[4][0])),
        ],
        [
            a(1.0, 6.0)
                * (s[1][2] * b[0][0]
                    + s[1][0] * b[0][4]
                    + s[2][2] * b[1][0]
                    + s[2][0] * b[1][4]
                    + s[0][2] * b[3][0]
                    + s[0][0] * b[3][4]),
            s[1][1] * b[0][0] + s[2][1] * b[1][0] + s[0][1] * b[3][0],
            a(5.0, 8.0) * (s[1][1] * b[0][1] + s[2][1] * b[1][1] + s[0][1] * b[3][1]),
            a(5.0, 9.0) * (s[1][1] * b[0][2] + s[2][1] * b[1][2] + s[0][1] * b[3][2]),
            a(5.0, 8.0) * (s[1][1] * b[0][3] + s[2][1] * b[1][3] + s[0][1] * b[3][3]),
            s[1][1] * b[0][4] + s[2][1] * b[1][4] + s[0][1] * b[3][4],
            a(1.0, 6.0)
                * (s[1][2] * b[0][4] - s[1][0] * b[0][0] + s[2][2] * b[1][4] - s[2][0] * b[1][0]
                    + s[0][2] * b[3][4]
                    - s[0][0] * b[3][0]),
        ],
        [
            a(4.0, 15.0) * (s[1][2] * b[1][0] + s[1][0] * b[1][4])
                + a(1.0, 5.0) * (s[0][2] * b[2][0] + s[0][0] * b[2][4])
                - a(1.0, 60.0)
                    * (s[2][2] * b[0][0] + s[2][0] * b[0][4]
                        - s[0][2] * b[4][0]
                        - s[0][0] * b[4][4]),
            a(8.0, 5.0) * s[1][1] * b[1][0] + a(6.0, 5.0) * s[0][1] * b[2][0]
                - a(1.0, 10.0) * (s[2][1] * b[0][0] - s[0][1] * b[4][0]),
            s[1][1] * b[1][1] + a(3.0, 4.0) * s[0][1] * b[2][1]
                - 0.25 * (s[2][1] * b[0][1] - s[0][1] * b[4][1]),
            a(8.0, 9.0) * s[1][1] * b[1][2] + a(2.0, 3.0) * s[0][1] * b[2][2]
                - a(1.0, 18.0) * (s[2][1] * b[0][2] - s[0][1] * b[4][2]),
            s[1][1] * b[1][3] + a(3.0, 4.0) * s[0][1] * b[2][3]
                - 0.25 * (s[2][1] * b[0][3] - s[0][1] * b[4][3]),
            a(8.0, 5.0) * s[1][1] * b[1][4] + a(6.0, 5.0) * s[0][1] * b[2][4]
                - a(1.0, 10.0) * (s[2][1] * b[0][4] - s[0][1] * b[4][4]),
            a(4.0, 15.0) * (s[1][2] * b[1][4] - s[1][0] * b[1][0])
                + a(1.0, 5.0) * (s[0][2] * b[2][4] - s[0][0] * b[2][0])
                - a(1.0, 60.0)
                    * (s[2][2] * b[0][4] - s[2][0] * b[0][0] - s[0][2] * b[4][4]
                        + s[0][0] * b[4][0]),
        ],
        [
            a(3.0, 10.0) * (s[1][2] * b[2][0] + s[1][0] * b[2][4])
                - a(1.0, 10.0)
                    * (s[2][2] * b[3][0]
                        + s[2][0] * b[3][4]
                        + s[0][2] * b[1][0]
                        + s[0][0] * b[1][4]),
            a(9.0, 5.0) * s[1][1] * b[2][0] - a(3.0, 5.0) * (s[2][1] * b[3][0] + s[0][1] * b[1][0]),
            a(9.0, 8.0) * s[1][1] * b[2][1] - a(3.0, 8.0) * (s[2][1] * b[3][1] + s[0][1] * b[1][1]),
            s[1][1] * b[2][2] - a(1.0, 3.0) * (s[2][1] * b[3][2] + s[0][1] * b[1][2]),
            a(9.0, 8.0) * s[1][1] * b[2][3] - a(3.0, 8.0) * (s[2][1] * b[3][3] + s[0][1] * b[1][3]),
            a(9.0, 5.0) * s[1][1] * b[2][4] - a(3.0, 5.0) * (s[2][1] * b[3][4] + s[0][1] * b[1][4]),
            a(3.0, 10.0) * (s[1][2] * b[2][4] - s[1][0] * b[2][0])
                - a(1.0, 10.0)
                    * (s[2][2] * b[3][4] - s[2][0] * b[3][0] + s[0][2] * b[1][4]
                        - s[0][0] * b[1][0]),
        ],
        [
            a(4.0, 15.0) * (s[1][2] * b[3][0] + s[1][0] * b[3][4])
                + a(1.0, 5.0) * (s[2][2] * b[2][0] + s[2][0] * b[2][4])
                - a(1.0, 60.0)
                    * (s[2][2] * b[4][0]
                        + s[2][0] * b[4][4]
                        + s[0][2] * b[0][0]
                        + s[0][0] * b[0][4]),
            a(8.0, 5.0) * s[1][1] * b[3][0] + a(6.0, 5.0) * s[2][1] * b[2][0]
                - a(1.0, 10.0) * (s[2][1] * b[4][0] + s[0][1] * b[0][0]),
            s[1][1] * b[3][1] + a(3.0, 4.0) * s[2][1] * b[2][1]
                - 0.25 * (s[2][1] * b[4][1] + s[0][1] * b[0][1]),
            a(8.0, 9.0) * s[1][1] * b[3][2] + a(2.0, 3.0) * s[2][1] * b[2][2]
                - a(1.0, 18.0) * (s[2][1] * b[4][2] + s[0][1] * b[0][2]),
            s[1][1] * b[3][3] + a(3.0, 4.0) * s[2][1] * b[2][3]
                - 0.25 * (s[2][1] * b[4][3] + s[0][1] * b[0][3]),
            a(8.0, 5.0) * s[1][1] * b[3][4] + a(6.0, 5.0) * s[2][1] * b[2][4]
                - a(1.0, 10.0) * (s[2][1] * b[4][4] + s[0][1] * b[0][4]),
            a(4.0, 15.0) * (s[1][2] * b[3][4] - s[1][0] * b[3][0])
                + a(1.0, 5.0) * (s[2][2] * b[2][4] - s[2][0] * b[2][0])
                - a(1.0, 60.0)
                    * (s[2][2] * b[4][4] - s[2][0] * b[4][0] + s[0][2] * b[0][4]
                        - s[0][0] * b[0][0]),
        ],
        [
            a(1.0, 6.0)
                * (s[1][2] * b[4][0] + s[1][0] * b[4][4] + s[2][2] * b[3][0] + s[2][0] * b[3][4]
                    - s[0][2] * b[1][0]
                    - s[0][0] * b[1][4]),
            s[1][1] * b[4][0] + s[2][1] * b[3][0] - s[0][1] * b[1][0],
            a(5.0, 8.0) * (s[1][1] * b[4][1] + s[2][1] * b[3][1] - s[0][1] * b[1][1]),
            a(5.0, 9.0) * (s[1][1] * b[4][2] + s[2][1] * b[3][2] - s[0][1] * b[1][2]),
            a(5.0, 8.0) * (s[1][1] * b[4][3] + s[2][1] * b[3][3] - s[0][1] * b[1][3]),
            s[1][1] * b[4][4] + s[2][1] * b[3][4] - s[0][1] * b[1][4],
            a(1.0, 6.0)
                * (s[1][2] * b[4][4] - s[1][0] * b[4][0] + s[2][2] * b[3][4]
                    - s[2][0] * b[3][0]
                    - s[0][2] * b[1][4]
                    + s[0][0] * b[1][0]),
        ],
        [
            0.5 * (s[2][2] * b[4][0] + s[2][0] * b[4][4] - s[0][2] * b[0][0] - s[0][0] * b[0][4]),
            a(3.0, 2.0) * (s[2][1] * b[4][0] - s[0][1] * b[0][0]),
            a(15.0, 16.0) * (s[2][1] * b[4][1] - s[0][1] * b[0][1]),
            a(5.0, 6.0) * (s[2][1] * b[4][2] - s[0][1] * b[0][2]),
            a(15.0, 16.0) * (s[2][1] * b[4][3] - s[0][1] * b[0][3]),
            a(3.0, 2.0) * (s[2][1] * b[4][4] - s[0][1] * b[0][4]),
            0.5 * (s[2][2] * b[4][4] - s[2][0] * b[4][0] - s[0][2] * b[0][4] + s[0][0] * b[0][0]),
        ],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(path: &Path) {
        let properties = [
            "f_dc_0", "x", "rot_0", "scale_0", "y", "f_dc_1", "rot_1", "scale_1", "z", "f_dc_2",
            "rot_2", "scale_2", "opacity", "rot_3",
        ];
        let mut bytes = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex 1\n{}end_header\n",
            properties
                .iter()
                .map(|name| format!("property float {name}\n"))
                .collect::<String>()
        )
        .into_bytes();
        let values = [
            0.1_f32, 1.0, 1.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 1.0, 0.0,
        ];
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn identity_sh_rotation_preserves_coefficients() {
        let rotation = ShRotation::new(Quaternion::from_euler_degrees([0.0, 0.0, 0.0]).matrix());
        let source = (1..=15).map(f64::from).collect::<Vec<_>>();
        let result = rotation.apply(&source);
        for (actual, expected) in result.iter().zip(source) {
            assert!((actual - expected).abs() < 1e-10, "{actual} != {expected}");
        }
    }

    #[test]
    fn playcanvas_euler_rotation_matches_expected_axis() {
        let q = Quaternion::from_euler_degrees([0.0, 0.0, 90.0]);
        let point = q.transform_point([1.0, 0.0, 0.0]);
        assert!(point[0].abs() < 1e-10);
        assert!((point[1] - 1.0).abs() < 1e-10);
    }

    #[test]
    fn z_rotation_matches_official_first_sh_band_mapping() {
        let rotation = ShRotation::new(Quaternion::from_euler_degrees([0.0, 0.0, 90.0]).matrix());
        let result = rotation.apply(&[1.0, 2.0, 3.0]);
        assert!((result[0] - 3.0).abs() < 1e-10);
        assert!((result[1] - 2.0).abs() < 1e-10);
        assert!((result[2] + 1.0).abs() < 1e-10);
    }

    #[test]
    fn streams_reordered_properties_and_auto_numbers_exports() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("final.ply");
        write_fixture(&source);
        let original = std::fs::read(&source).unwrap();
        let transform = GaussianTransform {
            position: [10.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 90.0],
            scale: 2.0,
        };
        let (first, info) =
            export_transformed_ply(&source, directory.path(), transform, |_, _| {}).unwrap();
        let (second, _) =
            export_transformed_ply(&source, directory.path(), transform, |_, _| {}).unwrap();
        assert_eq!(first.file_name().unwrap(), "edited.ply");
        assert_eq!(second.file_name().unwrap(), "edited-2.ply");
        assert_eq!(info.splat_count, 1);
        assert_eq!(std::fs::read(&source).unwrap(), original);

        let mut reader = BufReader::new(File::open(first).unwrap());
        let layout = parse_layout(&mut reader).unwrap();
        let mut row = vec![0_u8; layout.stride];
        reader.read_exact(&mut row).unwrap();
        let get = |name: &str| read_float(&row, layout.offsets[name]);
        assert!((get("x") - 10.0).abs() < 1e-5);
        assert!((get("y") - 2.0).abs() < 1e-5);
        assert!(get("z").abs() < 1e-5);
        assert!((get("scale_0") - 2.0_f64.ln()).abs() < 1e-5);
        assert!((get("rot_0") - 0.5_f64.sqrt()).abs() < 1e-5);
        assert!((get("rot_3") - 0.5_f64.sqrt()).abs() < 1e-5);
    }
}
