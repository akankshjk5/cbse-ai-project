# Running Lumina lesson videos for a demo

This gets the website running on your Windows laptop, connected to a RunPod GPU,
so you can generate narrated lesson videos live. Plan about 30 minutes the first
time: most of it is the Pod preparing itself.

## What you need from the project owner (sent privately, never posted)

1. Access to the code (the GitHub repository and branch below).
2. The `.env.local` file (website sign-in and database settings).
3. The `.runpod-worker.env` file (the Pod worker's database key).
4. A RunPod Pod started on the owner's account, from the template that mounts
   the Lumina storage volume, with a **RTX 6000 Ada** GPU. The owner shares the
   Pod's "SSH over exposed TCP" address and port, for example `195.26.233.34` and `28154`.
5. The login for the website account the videos run under.

## One-time laptop setup

Install [Node.js 20 or newer](https://nodejs.org) and [Git](https://git-scm.com), then in PowerShell:

```powershell
git clone https://github.com/gauravbshet/lumina-deck-pro.git
cd lumina-deck-pro
git checkout feat/motion-present-and-public-launch
npm install
```

Put the two files from the owner into the `lumina-deck-pro` folder:
`.env.local` and `.runpod-worker.env`.

Create your SSH key (press Enter at every question) and print it:

```powershell
ssh-keygen -t ed25519
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

## Each demo day

1. **Let the Pod accept your key.** Copy the line printed above (it starts with
   `ssh-ed25519`). In RunPod, open the Pod, enable **Web terminal**, open it and run
   (replace `PASTE-YOUR-KEY-LINE` with your line, keep the quotes):

   ```bash
   mkdir -p /root/.ssh && echo 'PASTE-YOUR-KEY-LINE' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && echo KEY-OK
   ```

   Tip: add the same line once under RunPod **Settings → SSH Public Keys** and new
   Pods will accept it automatically.

2. **Set up the Pod and connect** (use the Pod's address and port):

   ```powershell
   cd lumina-deck-pro
   powershell -ExecutionPolicy Bypass -File scripts\connect-runpod.ps1 -PodHost 195.26.233.34 -PodPort 28154
   ```

   It copies the code to the Pod, rebuilds it (15-20 minutes on a fresh Pod,
   about a minute if it was already set up), starts every service, and opens a
   tunnel window. **Leave that tunnel window open.**

3. **Start the website** in a second PowerShell window:

   ```powershell
   cd lumina-deck-pro
   npm run dev
   ```

4. Open **http://localhost:3000/app/videos**, sign in with the shared account,
   pick class, subject, topic, language and length, and press
   **Generate narrated video**.

## What to expect during the demo

- About 3-5 minutes of preparation (lesson plan, fact check, translation,
  voice-over), then about 12-15 minutes of rendering for a 60-second video.
  Scene previews appear one by one while it renders.
- For a live pitch, start one video before you begin talking, or show a
  finished one from the **Recent videos** list.
- Specific topics work best ("Photosynthesis in plants" rather than "plants").

## If something goes wrong

| Message | Fix |
|---|---|
| `Permission denied (publickey)` | Step 1 was not done on this Pod. |
| `Video backend is not ready (...)` | The tunnel window closed or the Pod is still starting. Re-run step 2. |
| The page does not load | `npm run dev` is not running (step 3). |
| Nothing happens after preparation | The worker has no credential: check `.runpod-worker.env` exists, then re-run step 2. |

**Stop the Pod in RunPod when the demo is over**, because it is billed while it runs.
