# check=skip=FromPlatformFlagConstDisallowed

# Runtime for reading RIEGL .rxp scans via RIEGL's closed-source RiVLib.
#
# WHY A CONTAINER AT ALL: RiVLib ships for Windows and Linux only — there is no
# macOS/Darwin build, and the .rxp format has no public specification. This image
# is how a Mac reads raw scanner data at all. Verified working under Rosetta on
# Apple silicon: 13,083,685 points in 5.7 s (2.31 M pts/s), so emulation cost is
# not a practical concern.
#
# RIVLIB IS NEVER BAKED IN. Its licence reads:
#
#     "You may NOT distribute or modify the software for the use in commercial
#      applications without the written consent of RLMS."
#
# so the library is bind-mounted read-only at run time from a copy the user
# downloaded themselves with their own RIEGL account. There is no COPY of it
# here, this image is safe to rebuild and (if it ever mattered) to publish, and
# `docker history` will never show licensed bytes. Do not "optimise" this by
# vendoring the .so.
#
# BASE IMAGE IS PINNED TO THE ABI, NOT TO TASTE. RiVLib is distributed per
# gcc/glibc ABI; the build we target is x86_64-linux-gcc9.5.0, and bullseye
# carries glibc 2.31, which loads it cleanly. Moving to bookworm (glibc 2.36) or
# to an Alpine/musl base would need a matching RiVLib download, so change the two
# together or not at all.
#
# ALWAYS linux/amd64: RiVLib has no arm64 Linux build either, so the platform is
# pinned here rather than left to the host. On Apple silicon this runs emulated.
#
# Usage (see scripts/riegl-probe.mjs for the real invocation):
#   docker build --platform linux/amd64 -t phytograph-riegl docker/riegl
#   docker run --rm --platform linux/amd64 \
#     -v /path/to/rivlib:/rivlib:ro \
#     -v /path/to/project.riproject:/project:ro \
#     phytograph-riegl python /opt/riegl/rxp_reader.py inspect /project

# The constant --platform is deliberate (RiVLib has no arm64 Linux build), so
# BuildKit's FromPlatformFlagConstDisallowed check is skipped at the top of this
# file rather than obeyed.
FROM --platform=linux/amd64 python:3.11-slim-bullseye

# numpy: point batches come back from RiVLib as C arrays and are bulk-copied
# into numpy rather than looped over in Python.
# laspy: still used by the standalone `extract` command (riegl-probe.mjs --out);
# the app's own path streams raw arrays instead.
RUN pip install --no-cache-dir numpy==2.2.1 laspy==2.5.4

# g++ compiles rxp_shim.cpp, which reads the NO-RETURN shots that the plain C
# scanifc API cannot see (see the shim's header comment). It cannot be compiled
# at image-build time because it links against libscanifc.so, and that library
# is bind-mounted at RUN time — its licence forbids us baking it in. So the
# toolchain ships and the shim is built on first use, into /tmp inside the
# container. It is ~90 KB of source and compiles in about a second.
#
# ABI NOTE: libscanifc.so is built with gcc 9.5.0 (__cxx11); this base image
# ships gcc 10. That pairing is verified working on real data — the C++ path
# reproduces the C API's echo and pulse counts exactly. If the base image ever
# moves to a much newer gcc, re-verify rather than assume.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*

COPY rxp_shim.cpp /opt/riegl/rxp_shim.cpp

# RiVLib's shared objects live here at run time via -v <host>:/rivlib:ro.
# Declaring the mountpoint and the loader path up front means the run command
# doesn't have to pass -e LD_LIBRARY_PATH every time.
ENV LD_LIBRARY_PATH=/rivlib/lib
RUN mkdir -p /rivlib

COPY rxp_reader.py /opt/riegl/rxp_reader.py

# Unbuffered so progress written to stdout reaches the host as it happens
# rather than in a lump when the process exits.
ENV PYTHONUNBUFFERED=1

WORKDIR /opt/riegl
ENTRYPOINT ["python", "/opt/riegl/rxp_reader.py"]
