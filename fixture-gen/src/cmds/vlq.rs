use serde::Serialize;
use sigma_ser::vlq_encode::{ReadSigmaVlqExt, WriteSigmaVlqExt};
use std::io::Cursor;

#[derive(Serialize)]
pub struct VlqCase {
    pub value: String,   // u64 as decimal string (JSON safety for large u64)
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct ZigZagCase {
    pub value: String,   // i64 as decimal string
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct VlqFixtures {
    pub u64: Vec<VlqCase>,
    pub i64: Vec<ZigZagCase>,
}

pub fn generate() -> anyhow::Result<VlqFixtures> {
    let u_values: Vec<u64> = vec![
        0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000,
        u32::MAX as u64, (u32::MAX as u64) + 1,
        u64::MAX - 1, u64::MAX,
    ];
    let mut u64_cases = Vec::new();
    for v in u_values {
        let mut buf: Vec<u8> = Vec::new();
        buf.put_u64(v)?;
        // Sanity: read it back.
        let mut cur = Cursor::new(buf.clone());
        let parsed = cur.get_u64()?;
        assert_eq!(parsed, v);
        u64_cases.push(VlqCase {
            value: v.to_string(),
            bytes_hex: hex::encode(buf),
        });
    }

    let i_values: Vec<i64> = vec![
        0, 1, -1, 63, -63, 64, -64, 127, -127, 128, -128,
        i32::MAX as i64, i32::MIN as i64,
        i64::MAX, i64::MIN,
    ];
    let mut i64_cases = Vec::new();
    for v in i_values {
        let mut buf: Vec<u8> = Vec::new();
        buf.put_i64(v)?;
        let mut cur = Cursor::new(buf.clone());
        let parsed = cur.get_i64()?;
        assert_eq!(parsed, v);
        i64_cases.push(ZigZagCase {
            value: v.to_string(),
            bytes_hex: hex::encode(buf),
        });
    }

    Ok(VlqFixtures { u64: u64_cases, i64: i64_cases })
}
