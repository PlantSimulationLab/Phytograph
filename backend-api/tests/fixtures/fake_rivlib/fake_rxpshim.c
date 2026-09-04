/*
 * A stand-in for the miss-recovery shim, paired with fake_scanifc.c.
 *
 * The real rxp_shim.cpp subclasses scanlib::pointcloud to reach the no-return
 * shots an .rxp does not store as points. On Windows that class exists only
 * inside a 49 MB static archive RIEGL's licence forbids us redistributing, so
 * the shim is compiled on the user's machine from their own SDK — and CI
 * without that SDK cannot build it at all.
 *
 * Without a stand-in, `stream` would fail outright in CI: stream_scan calls
 * collect_misses unconditionally, and on a runner that HAS a compiler but not
 * RiVLib the build fails with a linker error rather than the "no toolchain"
 * state the import knows how to degrade through. So this exports the same
 * eight symbols with synthetic misses, and PHYTOGRAPH_RXP_SHIM points the
 * reader at it.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It cannot validate the real shim's
 * decoding — that needs RIEGL's headers and a real scan. What it does cover is
 * everything DOWNSTREAM of the shim boundary, which is where the bugs have
 * actually been: the ctypes binding to these eight symbols, the shot-count
 * reconciliation, miss placement on the 20 km shell, the is_miss column, and
 * the hits+misses concatenation that has to keep every per-point array the
 * same length.
 *
 * THE COUNTS ARE A CONTRACT with fake_scanifc.c. stream_scan raises unless
 * shots == hit_shots + misses, and the reader cross-checks the echo count
 * against what the C API returned. Change one file's numbers and you must
 * change the other's.
 */

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define FAKE_API __declspec(dllexport)
#else
#define FAKE_API __attribute__((visibility("default")))
#endif

/* Must match fake_scanifc.c: 1000 pulses, every 5th returning twice. */
#define FAKE_PULSES 1000
#define FAKE_ECHOES 1200
#define FAKE_MISSES 200
#define FAKE_SHOTS (FAKE_PULSES + FAKE_MISSES)

#define FAKE_T0 1000000000ULL
#define FAKE_DT 100000ULL

typedef struct {
    double dirs[FAKE_MISSES * 3];
    double times[FAKE_MISSES];
} fake_result;

FAKE_API void *rxpshim_collect_misses(const char *uri) {
    (void)uri;
    fake_result *r = (fake_result *)calloc(1, sizeof *r);
    if (!r) return NULL;
    for (int i = 0; i < FAKE_MISSES; ++i) {
        /* Unit vectors — the reader multiplies these by the 20 km miss
         * distance, so a non-unit direction would place the shell wrong
         * without erroring. Spread over a hemisphere so the miss cloud has
         * real extent and the bbox/octree paths see something plausible. */
        const double az = (i * 7 % 360) * (3.14159265358979 / 180.0);
        const double el = ((i % 45) + 5) * (3.14159265358979 / 180.0);
        r->dirs[i * 3 + 0] = cos(el) * cos(az);
        r->dirs[i * 3 + 1] = cos(el) * sin(az);
        r->dirs[i * 3 + 2] = sin(el);
        /* Interleaved with the hits' timeline, in seconds, as time_sorg is. */
        r->times[i] = (double)(FAKE_T0 + (uint64_t)(i * 5) * FAKE_DT) / 1e9;
    }
    return r;
}

FAKE_API const char *rxpshim_error(void *h) {
    (void)h;
    return "";
}

FAKE_API uint64_t rxpshim_miss_count(void *h) {
    return h ? FAKE_MISSES : 0;
}

FAKE_API uint64_t rxpshim_shot_count(void *h) {
    return h ? FAKE_SHOTS : 0;
}

FAKE_API uint64_t rxpshim_hit_shot_count(void *h) {
    return h ? FAKE_PULSES : 0;
}

FAKE_API uint64_t rxpshim_echo_count(void *h) {
    return h ? FAKE_ECHOES : 0;
}

FAKE_API void rxpshim_copy(void *h, double *dirs, double *times) {
    fake_result *r = (fake_result *)h;
    if (!r) return;
    if (dirs) memcpy(dirs, r->dirs, sizeof r->dirs);
    if (times) memcpy(times, r->times, sizeof r->times);
}

FAKE_API void rxpshim_free(void *h) {
    free(h);
}
