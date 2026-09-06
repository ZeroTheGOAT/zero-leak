//! A minimal GGUF header reader: just enough metadata to size a model's KV
//! cache.
//!
//! llama-server is started with one `ctx-size` per model, chosen up front. To
//! size it against the card actually running we need `KV per token`, which the
//! catalogue does not carry — but the checkpoint's own header does: the number
//! of decoder blocks and the attention head geometry. GGUF metadata is a
//! little-endian stream: magic, version, tensor count, then `count` typed
//! key/value pairs, then tensor info. We read only the metadata section (a few
//! kilobytes into a multi-gigabyte file) and stop.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// The attention geometry that fixes a model's KV-cache bytes per token.
///
/// Total KV elements per token = `layers * heads * (key_len + value_len)`.
/// (GQA models repeat the KV heads across attention heads; the cache stores one
/// copy per KV head, so `heads` here is `head_count_kv`, not `head_count`.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KvGeometry {
    pub layers: u32,
    pub heads: u32,
    pub key_len: u32,
    pub value_len: u32,
}

impl KvGeometry {
    /// MiB of KV cache per token for a llama.cpp `cache-type-k/v` value.
    /// `f16`/`f32` are one element per byte width; the quantised types store a
    /// block of 32 elements plus a two-byte scale. Unknown types return `None`
    /// and the caller falls back to the catalogue baseline rather than guess.
    pub fn kv_mb_per_token(&self, cache_type: &str) -> Option<f64> {
        let bytes_per_elem = cache_bytes_per_elem(cache_type)?;
        Some(
            self.layers as f64
                * self.heads as f64
                * (self.key_len + self.value_len) as f64
                * bytes_per_elem
                / (1024.0 * 1024.0),
        )
    }
}

fn cache_bytes_per_elem(cache_type: &str) -> Option<f64> {
    match cache_type {
        "f16" | "i16" => Some(2.0),
        "f32" => Some(4.0),
        "q8_0" => Some(34.0 / 32.0),
        "q4_0" => Some(18.0 / 32.0),
        "q4_1" => Some(20.0 / 32.0),
        "q5_0" => Some(22.0 / 32.0),
        "q5_1" => Some(24.0 / 32.0),
        "i8" => Some(1.0),
        _ => None,
    }
}

/// Reads the four geometry keys from a GGUF file on disk.
///
/// Returns `None` — never an error — when the file is absent, unreadable, not
/// GGUF, or lacks one of the keys (some architectures name them differently or
/// store per-layer arrays, which this reader deliberately does not chase). Each
/// failure means "leave this model at its catalogue window".
pub fn kv_geometry(path: &Path) -> Option<KvGeometry> {
    let file = File::open(path).ok()?;
    let mut r = BufReader::new(file);
    geometry_from(&mut r)
}

/// Reads geometry from any byte source. Split out so a test can hand this a
/// hand-built header without touching the filesystem.
fn geometry_from<R: Read>(r: &mut R) -> Option<KvGeometry> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != b"GGUF" {
        return None;
    }
    // version (u32), tensor_count (u64) — parsed only so the stream position is
    // right to walk the metadata that follows.
    read_u32(r)?;
    let _tensor_count = read_u64(r)?;
    let n_kv = read_u64(r)?;

    let mut layers = None;
    let mut heads = None;
    let mut key_len = None;
    let mut value_len = None;

    for _ in 0..n_kv {
        let key = read_string(r)?;
        let ty = read_u32(r)?;

        // Numeric scalar? A geometry value arrives as one of the unsigned/signed
        // int widths. Strings and arrays are skipped; a per-layer array for one
        // of these keys simply means "not readable here" and leaves the field
        // None, which is the same answer the file-missing case gets.
        // `None` value means "present in the file, not a usable number": the
        // bytes are consumed so the stream stays aligned, but nothing is stored.
        let value = match ty {
            0 | 1 | 2 | 3 | 4 | 5 | 10 | 11 => read_int(r, ty)?,
            6 => {
                skip(r, 4)?;
                None
            }
            7 => {
                skip(r, 1)?;
                None
            }
            8 => {
                // String: length-prefixed, then the bytes we do not need.
                let len = read_u64(r)?;
                skip(r, len)?;
                None
            }
            9 => {
                // Array: element type, count, then elements. Only the byte size
                // of the payload matters for skipping.
                let elem_ty = read_u32(r)?;
                let count = read_u64(r)?;
                let elem_bytes = match elem_ty {
                    0 | 1 => 1u64,
                    2 | 3 | 4 | 5 => 4,
                    6 => 4,
                    7 => 1,
                    10 | 11 => 8,
                    12 => 8,
                    8 => {
                        // Strings are variable length: read each length and skip
                        // its body. (Reading the body here is what advances past
                        // it — do not also skip the summed lengths afterwards.)
                        for _ in 0..count {
                            let len = read_u64(r)?;
                            skip(r, len)?;
                        }
                        continue;
                    }
                    9 => return None, // nested arrays are not worth chasing
                    _ => return None,
                };
                skip(r, count.saturating_mul(elem_bytes))?;
                None
            }
            12 => {
                skip(r, 8)?;
                None
            }
            _ => return None,
        };

        if let Some(v) = value {
            if key.ends_with(".block_count") {
                layers = Some(v);
            } else if key.ends_with("attention.head_count_kv") {
                heads = Some(v);
            } else if key.ends_with("attention.key_length") {
                key_len = Some(v);
            } else if key.ends_with("attention.value_length") {
                value_len = Some(v);
            }
        }
    }

    Some(KvGeometry {
        layers: u32::try_from(layers?).ok()?,
        heads: u32::try_from(heads?).ok()?,
        key_len: u32::try_from(key_len?).ok()?,
        value_len: u32::try_from(value_len?).ok()?,
    })
}

/// Reads a length-prefixed UTF-8 key/string body.
fn read_string<R: Read>(r: &mut R) -> Option<String> {
    let len = read_u64(r)?;
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// Reads one int-width scalar (u8/i8/u16/i16/u32/i32/u64/i64) as a non-negative
/// u32 value. A signed type holding a negative number is consumed and reported
/// as "no usable value" rather than read as a huge unsigned.
fn read_int<R: Read>(r: &mut R, ty: u32) -> Option<Option<u32>> {
    match ty {
        0 => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b).ok()?;
            Some(Some(b[0] as u32))
        }
        1 => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b).ok()?;
            match b[0] as i8 {
                v if v < 0 => Some(None),
                v => Some(Some(v as u32)),
            }
        }
        2 => read_u16(r).map(|v| Some(v as u32)),
        3 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b).ok()?;
            match i16::from_le_bytes(b) {
                v if v < 0 => Some(None),
                v => Some(Some(v as u32)),
            }
        }
        4 => read_u32(r).map(Some),
        5 => {
            let mut b = [0u8; 4];
            r.read_exact(&mut b).ok()?;
            match i32::from_le_bytes(b) {
                v if v < 0 => Some(None),
                v => Some(Some(v as u32)),
            }
        }
        10 => read_u64(r).map(|v| Some(u32::try_from(v).unwrap_or(u32::MAX))),
        11 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b).ok()?;
            match i64::from_le_bytes(b) {
                v if v < 0 => Some(None),
                v => Some(Some(u32::try_from(v).unwrap_or(u32::MAX))),
            }
        }
        _ => None,
    }
}

fn read_u16<R: Read>(r: &mut R) -> Option<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b).ok()?;
    Some(u16::from_le_bytes(b))
}

fn read_u32<R: Read>(r: &mut R) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> Option<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

fn skip<R: Read>(r: &mut R, n: u64) -> Option<()> {
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Appends bytes to a hand-built little-endian buffer.
    struct Buf(Vec<u8>);
    impl Buf {
        fn u32(&mut self, v: u32) {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
        fn u64(&mut self, v: u64) {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
        fn str(&mut self, s: &str) {
            self.u64(s.len() as u64);
            self.0.extend_from_slice(s.as_bytes());
        }
        fn u32_val(&mut self, key: &str, v: u32) {
            self.str(key);
            self.u32(4); // UINT32
            self.u32(v);
        }
    }

    fn parse(bytes: &[u8]) -> Option<KvGeometry> {
        let mut cursor = std::io::Cursor::new(bytes.to_vec());
        geometry_from(&mut cursor)
    }

    #[test]
    fn parses_qwen_style_geometry() {
        let mut b = Buf(Vec::new());
        b.0.extend_from_slice(b"GGUF");
        b.u32(3); // version
        b.u64(1); // tensor count (unused)
        b.u64(4); // four metadata pairs
        b.u32_val("qwen35.block_count", 33);
        b.u32_val("qwen35.attention.head_count_kv", 4);
        b.u32_val("qwen35.attention.key_length", 256);
        b.u32_val("qwen35.attention.value_length", 256);
        let g = parse(&b.0).expect("geometry parsed");
        assert_eq!((g.layers, g.heads, g.key_len, g.value_len), (33, 4, 256, 256));

        // 33 * 4 * 512 elements at the cache type's bytes-per-element:
        // q8_0 ≈ 70.1 KiB/token, f16 = 132 KiB/token — the two figures the
        // whole sizing scheme is built on.
        let q8_kib = g.kv_mb_per_token("q8_0").unwrap() * 1024.0;
        assert!((q8_kib - 70.125).abs() < 1e-3, "q8_0 KiB/token = {q8_kib}");
        let f16_kib = g.kv_mb_per_token("f16").unwrap() * 1024.0;
        assert!((f16_kib - 132.0).abs() < 1e-3, "f16 KiB/token = {f16_kib}");
        // Unknown cache types refuse rather than guess.
        assert!(g.kv_mb_per_token("q3_K").is_none());
    }

    #[test]
    fn missing_geometry_key_is_unreadable_not_partial() {
        // Only three of the four keys: a real file laid out this way (or an
        // architecture that stores per-layer arrays, which we do not chase)
        // means "cannot size it", and sizing must fall back to the catalogue
        // rather than launch on a half-guessed KV cost. So this returns None.
        let mut b = Buf(Vec::new());
        b.0.extend_from_slice(b"GGUF");
        b.u32(3);
        b.u64(1);
        b.u64(3);
        b.u32_val("qwen35.block_count", 33);
        b.u32_val("qwen35.attention.head_count_kv", 4);
        b.u32_val("qwen35.attention.key_length", 256);
        assert!(parse(&b.0).is_none());
    }

    #[test]
    fn survives_strings_arrays_and_signed_negatives_in_metadata() {
        let mut b = Buf(Vec::new());
        b.0.extend_from_slice(b"GGUF");
        b.u32(3);
        b.u64(1);
        b.u64(8); // eight metadata pairs
        // A description string before the geometry keys.
        b.str("general.name");
        b.u32(8); // STRING
        b.str("Qwen3.5 9B");
        // An int32 holding a negative number: read and discarded, not a crash.
        b.str("some.negative");
        b.u32(5); // INT32
        b.0.extend_from_slice(&(-4i32).to_le_bytes());
        // An empty u64 array.
        b.str("some.empty_array");
        b.u32(9); // ARRAY
        b.u32(10); // UINT64 elements
        b.u64(0); // zero of them
        // An array of strings (e.g. stop tokens).
        b.str("tokenizer.ggml.model");
        b.u32(9); // ARRAY
        b.u32(8); // STRING elements
        b.u64(3); // three of them
        b.str("first");
        b.str("second");
        b.str("third");
        // Now the real keys.
        b.u32_val("qwen35.block_count", 33);
        b.u32_val("qwen35.attention.head_count_kv", 4);
        b.u32_val("qwen35.attention.key_length", 256);
        b.u32_val("qwen35.attention.value_length", 256);
        let g = parse(&b.0).expect("geometry still parsed around noise");
        assert_eq!((g.layers, g.heads, g.key_len, g.value_len), (33, 4, 256, 256));
    }

    #[test]
    fn rejects_non_gguf() {
        assert!(parse(b"not a gguf file at all").is_none());
    }
}

    /// Reads the geometry off the real shipped weights, so a change in how GGUF
    /// metadata is laid out (a new converter, a re-download) breaks the build
    /// loudly instead of silently leaving every model at its catalogue window.
    /// Ignored by default because the multi-GiB files need not be present on every
    /// developer machine; run it explicitly on a machine with the weights.
    #[test]
    #[ignore = "needs the real weights under ../../models; run: cargo test --bin zeroleak-ai -- --ignored gguf::real_gemma_and_cascade"]
    fn real_gemma_and_cascade_geometry_are_readable() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models");
        let gemma = root.join("gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf");
        let g = kv_geometry(&gemma).unwrap_or_else(|| {
            panic!("Gemma header not parsed at {}", gemma.display())
        });
        assert_eq!((g.layers, g.heads, g.key_len, g.value_len), (42, 2, 512, 512));
        let mb = g.kv_mb_per_token("q8_0").unwrap();
        assert!((0.08..0.10).contains(&mb), "Gemma q8_0 KV should be ~89 KiB/token, got {mb}");

        let cascade = root.join("nemotron-cascade-8b/nvidia_Nemotron-Cascade-8B-Q4_K_M.gguf");
        let g = kv_geometry(&cascade).unwrap_or_else(|| {
            panic!("cascade header not parsed at {}", cascade.display())
        });
        assert!(g.layers > 0 && g.heads > 0 && g.key_len > 0 && g.value_len > 0);
    }
