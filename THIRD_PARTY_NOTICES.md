# Third-party notices

## ChordMini ChordNet 2E1D model

SoloTrace includes the ChordMini ChordNet 2E1D ONNX community export from
`musetric/chordmini-onnx`, pinned to repository revision
`fbd620e6a7617bbc82795b1f0c828a7721c213f4`. The model repository declares MIT
licensing inherited from the upstream ChordMini weights. Exact file hashes,
source links, and the community-export caveat are preserved in
`server/solotrace/resources/chordmini/NOTICE.md`.

SoloTrace includes third-party software. The packaged app contains the exact
license files collected from installed Python distributions under
`Contents/Resources/licenses/python`.

Material runtime components include:

- FFmpeg, built from official source without GPL or nonfree options and
  redistributed under LGPL-2.1-or-later. The source version, build
  configuration, and LGPL text are bundled under
  `Contents/Resources/licenses/ffmpeg`.
- yt-dlp 2026.07.04, distributed under the Unlicense. The bundled official
  macOS executable contains separately licensed dependencies documented by
  the upstream release.
- Deno 2.9.4, distributed under the MIT License. It runs yt-dlp's bundled
  YouTube challenge code with restricted permissions. YouTube-tool license
  texts are bundled under `Contents/Resources/licenses/youtube`.
- Spotify Basic Pitch and its model, Apache-2.0.
- Python, PSF-2.0.
- FastAPI, Starlette, Uvicorn, HTTPX, NumPy, SciPy, librosa, SoundFile, mido,
  pywebview, PyInstaller, coremltools, keyring, and their transitive
  dependencies under their respective bundled notices.
- React and Vite runtime assets under their respective licenses.

Copyright remains with each upstream author. Inclusion does not imply
endorsement.
