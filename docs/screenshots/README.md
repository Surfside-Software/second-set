# Screenshot sources

The README screenshots are full frames from `moke-demo-voiceover-final.mp4`, the
local final narrated demo cut rendered on November 4, 2026. They retain the
recorded app UI, cursor, and footage labels at the video resolution of
2560 × 1440. The video edit already cropped the window title bar and scaled the
footage. Frame extraction adds no further cropping or content edits.

[Watch the demo on YouTube](https://youtu.be/wl8wwq_Tlrw).

Source video SHA-256:

```text
a9fc56262ddd25e83f0aef285f5fd33f95bbe3375d2a0a5840e96d3339afe5cb
```

| Image                            | Video timestamp | Content                                                                                                                                |
| -------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [workbench.png](workbench.png)   | 00:01:32        | Five-sheet civil review with 19 findings, coverage gaps, and findings navigation                                                       |
| [correction.png](correction.png) | 00:01:48        | Source evidence with a SAM highlight and a saved false-alarm decision explaining that identifying information was removed for the demo |
| [revision.png](revision.png)     | 00:02:02        | Earlier 13-sheet review showing an unresolved Rev 1 area discrepancy and the saved reviewer decision                                   |

The revision frame retains the video's "Oct 31 footage, 13-sheet set" label.
It is from a different review than the five-sheet civil example.

## Extract the frames

With FFmpeg installed, run these commands from the repository root. Set
`MOKE_DEMO_VIDEO` to the local copy of the source video; the video itself is not
stored in this repository.

```sh
export MOKE_DEMO_VIDEO=/path/to/moke-demo-voiceover-final.mp4
ffmpeg -hide_banner -loglevel error -y -ss 92 -i "$MOKE_DEMO_VIDEO" -frames:v 1 -threads 2 docs/screenshots/workbench.png
ffmpeg -hide_banner -loglevel error -y -ss 108 -i "$MOKE_DEMO_VIDEO" -frames:v 1 -threads 2 docs/screenshots/correction.png
ffmpeg -hide_banner -loglevel error -y -ss 122 -i "$MOKE_DEMO_VIDEO" -frames:v 1 -threads 2 docs/screenshots/revision.png
```

`bun run test:screenshots` captures the offline synthetic fixture into
`test-results/`. It does not replace these demo frames.
