# Model licence audit

**Verified 18 October 2026** against the official Hugging Face repositories,
plus two rows added and verified on 20 October 2026 after a test found the code
loads twelve models while this audit listed ten. All twelve rows are now
publisher-verified; the one remaining open question is Q1, which is about
provenance rather than about a licence tag.
Re-verify before a tender submission: a model card can change, and a licence
tag is metadata the publisher can edit at any time.

**This is a record of what the publishers state, not legal advice.** Nothing
here is a guarantee of commercial suitability, and the unresolved questions at
the end are not rhetorical — two of them should be settled by someone with
authority to accept the risk before this stack is used commercially.

No weights were downloaded to produce this audit.

## Why each component is listed separately

The workflows load six weight files, and they do not all come from the model
whose name is on the stage. `qwen_3_4b.safetensors` is Z-Image's text encoder,
not the planner. `ae.safetensors` is an autoencoder Z-Image reuses rather than
one Tongyi trained. Treating "the Z-Image licence" as covering all three is the
assumption this audit exists to avoid.

## The table

| Component | Repository | Licence | Commercial use | Notes |
|---|---|---|---|---|
| Planner | [`Qwen/Qwen3-4B`](https://huggingface.co/Qwen/Qwen3-4B) | `apache-2.0` | Permitted | Citation requested, not required |
| Image model | [`Comfy-Org/z_image_turbo`](https://huggingface.co/Comfy-Org/z_image_turbo) → `z_image_turbo_bf16.safetensors` | `apache-2.0` | Permitted | Repackaged; upstream [`Tongyi-MAI/Z-Image-Turbo`](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) also `apache-2.0` |
| Image text encoder | same repo → `qwen_3_4b.safetensors` | `apache-2.0` | Permitted | Distinct file from the planner above |
| Image VAE | same repo → `ae.safetensors` | `apache-2.0` *as declared* | **See Q1** | 335 MB. Community sources describe it as the FLUX.1 autoencoder |
| Motion model | [`Comfy-Org/Wan_2.2_ComfyUI_Repackaged`](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) → `wan2.2_ti2v_5B_fp16.safetensors` | `apache-2.0` | Permitted | Upstream [`Wan-AI/Wan2.2-TI2V-5B`](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) states it explicitly in a Licence Agreement section |
| Motion text encoder | same repo → `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `apache-2.0` | Permitted | Upstream [`google/umt5-xxl`](https://huggingface.co/google/umt5-xxl) is `apache-2.0` |
| Motion VAE | same repo → `wan2.2_vae.safetensors` | `apache-2.0` | Permitted | Wan-trained, covered by the Wan licence agreement |
| Vision check | [`Qwen/Qwen2.5-VL-7B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) | `apache-2.0` | Permitted | The **7B** is Apache-2.0. Larger Qwen-VL variants have historically used a custom licence — do not substitute a bigger one without re-checking |
| Speech | [`ai4bharat/indic-parler-tts`](https://huggingface.co/ai4bharat/indic-parler-tts) | `apache-2.0` | Permitted | **See Q2** |
| Translation | [`ai4bharat/indictrans2-en-indic-1B`](https://huggingface.co/ai4bharat/indictrans2-en-indic-1B) | `mit` | Permitted | **See Q3** |
| Listen-back ASR | [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo) | `mit` | Permitted | Loaded by `local_tts_service.py` to transcribe each take. Added and verified 20 October 2026. **MIT, not Apache-2.0** — recorded wrongly when first added |
| Speech description tokenizer | [`google/flan-t5-large`](https://huggingface.co/google/flan-t5-large) | `apache-2.0` | Permitted | Tokenizer files only. Added and verified 20 October 2026. Card advises a safety assessment before using the model directly; Lumina uses only its tokenizer, so it generates no text |

## What was confirmed beyond the licence

**Indic Parler-TTS officially supports all three languages Lumina needs.**
The model card names Kannada (recommended speakers Suresh, Anu), Hindi (Rohit,
Divya) and Indian English accents. Kannada is also one of ten languages with
officially supported emotion prompts.

That is the publisher's claim about coverage, not a judgement about quality.
Whether Kannada pronunciation is good enough for a classroom is a listening
test on real output, and no audio has been generated yet.

**The Wan licence agreement is explicit** where most cards only carry a tag:
the Wan team claims no rights over generated content, and places
responsibility for use on the user.

## Unresolved questions

**Q1 — What is `ae.safetensors`, exactly?**
`Comfy-Org/z_image_turbo` declares Apache-2.0 for the whole repository, and
that covers this file as redistributed. Community documentation describes it as
the FLUX.1 autoencoder reused by Z-Image. This matters because the two FLUX.1
lines carry different terms: **FLUX.1-schnell's components are Apache-2.0,
while FLUX.1-dev's are under a non-commercial licence.** A redistributor's tag
is not the upstream grant, and if this file descends from the dev line the tag
is wrong.

*Resolve by:* asking Comfy-Org or Tongyi to state the VAE's provenance, or
comparing the file's tensor hashes against the published FLUX.1-schnell
autoencoder. Until then, treat commercial use of the image stage as **carrying
an unquantified risk**, not as cleared.

**Q2 — Do Indic Parler-TTS's training-data terms reach the model?**
The card lists training datasets under CC BY 4.0 and CC V1 while licensing the
model Apache-2.0, and does not explain how the dataset terms flow through to
model outputs. Most publishers treat trained weights as a separate work; that
is a common position, not a settled one.

*Resolve by:* a written answer from AI4Bharat, or a decision by someone
authorised to accept the risk.

**Q3 — IndicTrans2 is gated.**
The licence is MIT, but the repository requires agreeing to share contact
information before files can be downloaded. That is an access condition rather
than a licence term, and it means **automated provisioning will fail** unless
the agreement is accepted once under the account that fetches the weights.

*Resolve by:* accepting the gate manually on the deployment account and
recording who accepted it and when.

**Q5 — RESOLVED 20 October 2026. Two models were missing from this audit.**
`openai/whisper-large-v3-turbo` and `google/flan-t5-large` are both loaded by
`local_tts_service.py` — the first transcribes every narration take for the
listen-back check, the second tokenises the voice description Indic Parler-TTS
conditions on. Neither appeared in this document until `ops/cloud/models.json`
was written and a test compared the two lists.

The audit said it covered the stack. It covered ten of twelve models.

Both model cards have now been read. **Whisper large-v3-turbo is MIT**, not
Apache-2.0 as it was first recorded here — permissive either way, but the
first entry was a guess dressed as a finding, which is the thing this document
exists not to do. **flan-t5-large is Apache-2.0** as expected. Neither is
gated and neither needs an access agreement.

flan-t5-large's card advises a safety and fairness assessment before using the
model directly. That is a usage guideline rather than a licence term, and
Lumina loads only its tokenizer files, so it generates no text and the
guideline does not bite.

Nothing further is outstanding on these two.

**Q4 — Repackaged repositories carry a redistributor's tag.**
Both Comfy-Org repositories declare Apache-2.0 for files they redistribute. For
Wan and Z-Image the upstream publishers independently declare Apache-2.0 too,
so the two agree. The exception is Q1, where no upstream has been identified at
all.

## What this audit does not cover

- **Generated output.** Licences here govern the weights. Whether a generated
  video can be published is a separate question, and for Lumina it is dominated
  by the KTBS textbook terms, which remain `unresolved`.
- **Dependencies.** PyTorch, ComfyUI, FFmpeg and libass have their own
  licences. FFmpeg's build flags matter: a build with `--enable-gpl` is GPL,
  and the binary tested on this machine reports `--enable-gpl --enable-version3`.
  That is a redistribution consideration if Lumina ever ships FFmpeg rather
  than depending on a system install.
- **Any claim that these models reproduce a proprietary system's output.**
  They are different models, and the comparison to make is between Lumina's own
  output and the supplied reference videos, measured rather than asserted.
