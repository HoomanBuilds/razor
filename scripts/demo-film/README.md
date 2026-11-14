# Razor recording kit

This kit records the isolated localhost demo, generates Sarah narration in separate cuts and assembles a 1920 by 1080, 30 fps MP4 under four minutes. It does not change the production application or use its credentials. Fictional local state demonstrates product behavior; it is not evidence of observed mainnet transfers, real customers or verified private inference.

Use Node.js 24, Chromium, FFmpeg and the existing local demo server. No new package installation is required. All generated media defaults to the ignored `.data/demo-film/` directory. Set `RAZOR_FILM_OUTPUT` to an absolute path when running from a feature worktree so its media survives worktree cleanup.

## Preparation

Read the approved [script and cut plan](../../docs/specs/demo-video.md). Narration and capture actions live in `story.mjs`. The local demo must be running at `http://localhost:3400`; its `/__demo/state` response must identify fictional records and disabled broadcasting. Keep its upstream interface running, too.

```sh
node scripts/demo-film/generate-voice.mjs --dry-run
node scripts/demo-film/generate-voice.mjs --env /absolute/path/to/existing/voice-credentials.env
node scripts/demo-film/cards.mjs --port 9225
```

The credential file is read only inside voice generation. Only `ELEVENLABS_API_KEY` is used. Sarah is pinned to voice `EXAVITQu4vr4xnSDxMaL`, model `eleven_v4`, seed `30102026`, stability `0.5`, similarity `0.8` and speed `1`, matching the selected narration reference. Requests run sequentially. An identical payload uses cached audio; revised audio preserves its prior fingerprinted version in `audio/history/`. Do not regenerate unchanged cuts.

## Recording cuts

```sh
node scripts/demo-film/capture.mjs --port 9225 --reset
node scripts/demo-film/capture.mjs --port 9225 --only 08-comparison
```

Record the full sequence in order after resetting. The funding and payroll cuts intentionally change only the sandbox state, and receiver cuts depend on that local settlement. Re-recording a dependent cut requires preparing its preceding state. Profile switching applies the sandbox cookie to Chromium and checks the resulting authenticated local identity. All non-loopback browser requests are blocked during capture.

Each cut records actual browser frames and timed UI actions. It retains the original frame timestamps, source MP4, before/after visible text and action times. Native UI changes are not replaced with counterfeit screenshots. Browser chrome is excluded. The recording query enables the sandbox's cleaner recording presentation without repeated environment badges. Capture never clicks an external wallet or blockchain explorer. Preserve the fictional-data provenance in this source kit and never describe this footage as verified mainnet settlement.

The browser port must be unused. The script launches and closes its own isolated Chromium profile and never attaches to a person's browser. FFmpeg uses two encoding threads. Run one capture or render process at a time and do not start an application production build concurrently.

## Assembly and review

```sh
node scripts/demo-film/render.mjs --plan-only
node scripts/demo-film/render.mjs --name razor-demo-v1-sarah.mp4
```

Assembly uses brief chapter cards, the unchanged action speed, and final holds where narration needs more time. Sarah is not accelerated. The script refuses a timeline longer than 240 seconds or stale narration, and verifies the final dimensions, frame rate, duration and audio stream. No music or subtitle layer is added.

Review the whole MP4 at normal speed, particularly approval, simulated delivery, recipient identity changes, the clearing calculation and the comparison notes. Retain `cuts/`, `audio/`, `capture/`, `timeline.json` and `verification.json` as the rebuild and evidence kit. Use a new output name for a new approved edition. The current master is not evidence of real token delivery or completed private inference.
