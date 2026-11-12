# H3 REF2VA deployment

User authorized switching 108 to REF2VA after requesting identity references independent of first frames. Deploy Abiray pruned NVFP4, pinned revision and SHA256, downloaded only on 108. Reuse CUDA 13, native reference conditioning, AWQ encoder and both VAEs. Keep CK attention and test fused MLP compatibility. Retain FL2VA as explicitly selectable fallback.

Add a fixed omniVideo workflow using MiniMaxH3ReferenceToVideo, with marked image/video/audio reference loaders. References feed reference inputs, never first_frame. Keep 20 steps, res_multistep, ref_image_size=match, default 5s. Existing two workers retain one job each and shared weights.

Fix the canvas repeat/retry callers to pass firstFrame/lastFrame only in frame mode. Keep API rejection of explicit frame inputs in omni mode. Test both caller paths, input aspect preservation and optional-reference pruning. Register REF2VA as new workflow/model and default using fresh revision CAS; preserve existing IDs and user configuration. Back up configuration before mutation.

Acceptance: remote hash verified, native graph loads, one-image identity test completes with valid video, multiple distinct image inputs bind correctly; worker/GPU and timing recorded. Report untested video/audio/reference maxima explicitly. No cloud model, local weight download, main merge, or destructive cleanup.
