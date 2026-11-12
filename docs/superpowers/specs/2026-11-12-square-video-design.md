# Square H3 video

The user explicitly requested 1:1 after the existing 16:9/9:16 restriction was explained. Add square 768x768 and 1024x1024 presets to the video panel and all H3 video profile validation. Keep existing landscape/portrait presets, defaults, fixed workflows and model bindings. Do not enable arbitrary numeric dimensions.

The square control appears only when the effective profile exposes square sizes. Filter resolution tiers by selected aspect; switching aspect picks the closest supported pixel area. Square values survive parsing, normalization, mode/model changes, persistence and the submitted native width/height. Preserve all existing labels and default 1344x768 / 768x1344 behavior.

Cover helper/model constraints, rendered aspect selection and submitted dimensions with focused tests. Run the actual FL2VA first/last workflow at 768x768 and REF2VA reference workflow at 1024x1024, 5s/20steps; verify encoded video dimensions and decoding. Deploy a tagged frontend build on108 without changing current global size or interrupting the Comfy workers. Verify the browser UI, then restore any global values modified during acceptance via fresh revision CAS.
