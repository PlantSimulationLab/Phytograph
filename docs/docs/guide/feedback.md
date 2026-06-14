# Reporting bugs & requesting features

Found a bug, or want a feature? Phytograph has two buttons in the top-right of
the Viewer toolbar — **Report a Bug** and **Request a Feature** — and matching
items under **Help → Report a Bug…** / **Request a Feature…** in the menu bar.

## How it works

Clicking either button opens a small dialog:

1. Give your report a short **Title**.
2. Add the **Details** — for a bug, what happened, what you expected, and the
   steps to reproduce it if you know them; for a feature, the problem you're
   trying to solve and how you imagine it working.
3. For a bug report, leave **Attach session logs** ticked (it's on by default
   for bugs) if you'd like to include a log of what the app did this session —
   see [Attaching logs](#attaching-logs) below.
4. Choose how to send it:

   - **I have a GitHub account** — opens a pre-filled issue on the Phytograph
     GitHub repository in your browser. You'll be asked to sign in to GitHub if
     you aren't already. Review the pre-filled form and click **Submit**.
   - **Continue without a GitHub account** — opens your email program with the
     report pre-filled, addressed to the Phytograph team. No account needed.

Either way, your title and details are carried over so you don't have to retype
them.

## What gets included

So that reports are easy to act on, Phytograph automatically attaches a small
**Environment** block — the Phytograph version, backend version, the PyHelios
and Helios (C++) engine versions, and your operating system. It's shown in the
dialog ("Includes: …") and appears in the
pre-filled issue/email, where you can review or edit it before sending. No other
data from your scans or files is included.

## Attaching logs

A bug is far easier to diagnose with the **session log** — a running record of
what the app, its Python backend, and the viewer did while it was open
(including any errors). Because GitHub issues and emails can't attach a file
automatically, Phytograph helps you attach it by hand:

1. With **Attach session logs** ticked, click your send button. Phytograph asks
   you where to save the log file (a `phytograph-logs-…txt` is suggested), writes
   it, and **opens the folder** with the file selected.
2. Your browser/email opens with the report pre-filled — the report text notes
   the log file's name under a **Session logs** heading.
3. **Drag the saved `phytograph-logs-…txt` file** from the folder into the
   GitHub issue (or attach it to the email) before submitting.

The log contains app, backend, and viewer messages plus version/OS information.
It does **not** contain the contents of your scans or point clouds, but it
**may include file names and paths** (which can contain your user name) for the
files you opened. You can open it in any text editor to review — and edit — it
before attaching. Untick the box if you'd rather not include it.

## If the app crashes

Some failures are too severe for the normal interface to recover from on its own
— the display engine can stop unexpectedly, or the Python compute backend can
fail to restart. When that happens, Phytograph shows a **crash dialog** instead
of leaving you with a blank window:

- **Reload** — restarts the part that crashed in place and tries to bring the
  app back without a full relaunch. (Your imported data lives in memory and is
  lost in a crash, so you'll need to re-import after reloading.)
- **View Logs** — writes the combined session log and opens the folder with it
  selected. This is the log that's actually useful for diagnosing the crash —
  not the cryptic system crash-dump files your operating system may also leave in
  a temporary folder.
- **Report** — opens a pre-filled bug report (GitHub, or email if you have no
  GitHub account) with the crash details and the log already written for you to
  attach, exactly like the [Attaching logs](#attaching-logs) flow above.
- **Quit** — closes Phytograph cleanly, shutting down the backend.

If a reload keeps crashing, use **Report** to send the log, then **Quit** and
relaunch.

### When the whole app closes unexpectedly

Some crashes take the entire application down at once — there's no chance to show
a dialog while it's happening. Phytograph still notices: the next time you launch
it, if the previous session didn't shut down cleanly, it shows a **"closed
unexpectedly"** dialog with the same **View Logs** and **Report** options. When
the operating system managed to capture a crash report, it's revealed alongside
the log so you can attach both. You can dismiss this and keep working — it's just
letting you know, and offering to help you report it.
