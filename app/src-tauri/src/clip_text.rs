// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! CLIP text preparation through the reference tokenizer's serialized pipeline.
use std::path::Path;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};
const CONTEXT: usize = 77;
const BOS: u32 = 49406;
const EOS: u32 = 49407;
pub struct TextProcessor(Tokenizer);
#[derive(Debug)]
pub struct TextInput {
    pub ids: Vec<i64>,
    pub attention: Vec<i64>,
}
impl TextProcessor {
    /// Caller must verify the entire pinned package before loading this file.
    pub fn load(root: &Path) -> Result<Self, String> {
        let tokenizer =
            Tokenizer::from_file(root.join("tokenizer.json")).map_err(|e| e.to_string())?;
        let processor = Self::configure(tokenizer)?;
        // Detect unsupported serialized pipelines rather than silently accepting
        // an implementation which tokenizes the matched model differently.
        let probe = processor.encode("a photo of a cat")?;
        if probe.ids[..7] != [49406, 320, 1125, 539, 320, 2368, 49407]
            || probe.attention.iter().sum::<i64>() != 7
        {
            return Err("Pinned CLIP tokenizer failed compatibility check".into());
        }
        Ok(processor)
    }
    fn configure(mut tokenizer: Tokenizer) -> Result<Self, String> {
        if tokenizer.token_to_id("<|startoftext|>") != Some(BOS)
            || tokenizer.token_to_id("<|endoftext|>") != Some(EOS)
        {
            return Err("CLIP tokenizer has incompatible special tokens".into());
        }
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: CONTEXT,
                ..Default::default()
            }))
            .map_err(|e| e.to_string())?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::Fixed(CONTEXT),
            pad_id: EOS,
            pad_token: "<|endoftext|>".into(),
            ..Default::default()
        }));
        Ok(Self(tokenizer))
    }
    pub fn encode(&self, text: &str) -> Result<TextInput, String> {
        if text.len() > 65536 {
            return Err("Search text exceeds 64 KiB".into());
        }
        let encoded = self.0.encode(text, true).map_err(|e| e.to_string())?;
        let ids = encoded.get_ids();
        let mask = encoded.get_attention_mask();
        let used = mask.iter().take_while(|&&m| m == 1).count();
        if ids.len() != CONTEXT
            || mask.len() != CONTEXT
            || used < 2
            || ids[0] != BOS
            || ids[used - 1] != EOS
            || ids.iter().any(|&id| id > EOS)
            || ids[used..].iter().any(|&id| id != EOS)
            || mask[used..].iter().any(|&m| m != 0)
        {
            return Err("CLIP tokenizer produced an invalid context".into());
        }
        Ok(TextInput {
            ids: ids.iter().map(|&id| i64::from(id)).collect(),
            attention: mask.iter().map(|&id| i64::from(id)).collect(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> TextProcessor {
        // Small synthetic WordLevel pipeline exercises the boundary contract;
        // this is not a replacement or golden fixture for the real CLIP BPE.
        let value = serde_json::json!({
            "version":"1.0", "truncation":null, "padding":null,
            "added_tokens":[], "normalizer":null,
            "pre_tokenizer":{"type":"Whitespace"},
            "post_processor":{"type":"TemplateProcessing",
                "single":[{"SpecialToken":{"id":"<|startoftext|>","type_id":0}},
                    {"Sequence":{"id":"A","type_id":0}},
                    {"SpecialToken":{"id":"<|endoftext|>","type_id":0}}],
                "pair":[{"Sequence":{"id":"A","type_id":0}},{"Sequence":{"id":"B","type_id":0}}],
                "special_tokens":{
                    "<|startoftext|>":{"id":"<|startoftext|>","ids":[49406],"tokens":["<|startoftext|>"]},
                    "<|endoftext|>":{"id":"<|endoftext|>","ids":[49407],"tokens":["<|endoftext|>"]}}},
            "decoder":null,
            "model":{"type":"WordLevel","vocab":{"<unk>":0,"cat":1,"<|startoftext|>":49406,"<|endoftext|>":49407},"unk_token":"<unk>"}
        });
        TextProcessor::configure(
            Tokenizer::from_bytes(serde_json::to_vec(&value).unwrap()).unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn fixed_context_empty_padding_and_unicode() {
        let processor = fixture();
        for (text, used) in [("", 2), ("cat", 3), ("猫 café", 4)] {
            let input = processor.encode(text).unwrap();
            assert_eq!(input.ids.len(), 77);
            assert_eq!(input.ids[0], i64::from(BOS));
            assert_eq!(input.ids[used - 1], i64::from(EOS));
            assert_eq!(input.attention.iter().sum::<i64>(), used as i64);
            assert!(input.ids[used..].iter().all(|&id| id == i64::from(EOS)));
        }
    }
    #[test]
    fn truncation_retains_final_eos_and_bounds_input() {
        let input = fixture().encode(&"cat ".repeat(200)).unwrap();
        assert_eq!(input.ids.len(), 77);
        assert_eq!(input.ids[76], i64::from(EOS));
        assert_eq!(input.attention.iter().sum::<i64>(), 77);
        assert!(fixture().encode(&"a".repeat(65537)).is_err());
        assert!(TextProcessor::configure(Tokenizer::new(
            tokenizers::models::wordlevel::WordLevel::default()
        ))
        .is_err());
    }
}
