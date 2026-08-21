# Headless-Linux reproduction environment for the E2E suite.
#
# WHY: a recurring class of failure in this project passes on macOS and fails
# only on CI's headless Linux runner (Dock-less Electron, xvfb, different GL
# stack, different float behaviour). Diagnosing those through 45-minute CI
# round-trips is slow and error-prone, so this image reproduces the runner
# locally.
#
# Matched to .github/workflows/ci.yml's `heavy` job:
#   - ubuntu-24.04, x86_64 (build with --platform linux/amd64 on Apple silicon;
#     arch matters — a past bug was an arm64-vs-x86_64 floating-point divergence)
#   - node 20, python 3.11
#   - the same apt set: libgl1-mesa-dev libglu1-mesa-dev xorg-dev libtbb-dev xvfb
#   - the suite is run under `xvfb-run -a -s "-screen 0 1920x1080x24"`
#
# This image holds only the TOOLCHAIN. The repo is bind-mounted at run time and
# the heavy native artifacts (libhelios, the PyInstaller bundle, PotreeConverter)
# are built inside a persistent volume, so they survive between runs — see
# run-e2e-docker.sh.
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base toolchain + CI's exact Linux build dependencies. `xvfb` provides the
# virtual display; Electron additionally needs the X client libs, nss/nspr and
# libasound that a desktop session would normally supply.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential cmake pkg-config \
      python3.12 python3.12-venv python3.12-dev python3-pip \
      libgl1-mesa-dev libglu1-mesa-dev xorg-dev libtbb-dev xvfb \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2t64 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 \
      libglib2.0-0 dbus dbus-x11 \
      # Electron links GTK3 (plus pango/cairo). Without libgtk-3.so.0 it exits
      # 127 at launch and Playwright reports only "Process failed to launch!".
      libgtk-3-0t64 libpango-1.0-0 libcairo2 libcairo-gobject2 \
      # x11-xserver-utils supplies xdpyinfo, used here to wait for Xvfb to be
      # ready (and by xvfb-run's own readiness probe, which blocks forever
      # without it even though Xvfb itself started correctly). x11-utils brings
      # its companions for debugging the display by hand.
      x11-xserver-utils x11-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 20, matching CI's actions/setup-node.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# The GitHub CLI: scripts/build-potree-converter.mjs shells out to `gh` to fetch
# upstream PR #686 as a patch (until it merges), and aborts without it. CI gets
# `gh` preinstalled on its runner image, so this is only needed here.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Electron sandbox needs either SUID or --no-sandbox; the suite runs as root in
# the container, so disable it the same way CI's xvfb-run invocation does.
ENV ELECTRON_DISABLE_SANDBOX=1

WORKDIR /work
CMD ["/bin/bash"]
