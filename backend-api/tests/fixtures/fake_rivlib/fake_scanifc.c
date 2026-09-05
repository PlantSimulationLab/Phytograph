/*
 * A stand-in for RIEGL's scanifc, so CI can exercise the .rxp reader.
 *
 * WHY THIS EXISTS
 * ---------------
 * Reading .rxp needs RiVLib, which is proprietary and cannot be committed or
 * published. That left the entire reader — the ctypes binding, the read loop,
 * pulse grouping, flag decoding, miss placement, the PHRX transport and the
 * backend's native runner — with no automated coverage at all: a struct field
 * could be reordered, or the URI form changed, and nothing would notice until
 * someone ran it against real scanner data by hand.
 *
 * The reader binds exactly SEVEN functions. That is small enough to stand in
 * for, and this file does: it emits a deterministic synthetic scan across the
 * same ABI, so `RIVLIB_SO=<this>` runs the whole pipeline with no licensed
 * bytes anywhere near it and no secrets in CI. It runs on fork PRs, which a
 * job needing the real library never can.
 *
 * WHAT IT CANNOT DO, and this matters: it proves nothing about how RIEGL's
 * library actually behaves. If RIEGL reorder a struct or change a return
 * convention, this stub happily keeps agreeing with our reader while both are
 * wrong. It catches OUR regressions, which are almost all of them; the real
 * library is a separate, credentialed job.
 *
 * THE STRUCT LAYOUTS BELOW ARE THE POINT. scanifc_point3dstream_read writes
 * into a caller-supplied array BY STRIDE, so a layout disagreement does not
 * raise — it silently yields garbage attributes and an under-filled buffer.
 * The reader asserts sizeof() at import for that reason; these must match
 * riegl/detail/pointsifc_t.h exactly, or the test is checking a fiction.
 *
 * Build: see build_fake_rivlib.py beside this file.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define FAKE_API __declspec(dllexport)
#else
#define FAKE_API __attribute__((visibility("default")))
#endif

/* riegl/detail/pointsifc_t.h — 12 bytes. */
typedef struct {
    float x, y, z;
} fake_xyz32;

/* riegl/detail/pointsifc_t.h — 16 bytes: two floats, two uint16s, one float. */
typedef struct {
    float amplitude;
    float reflectance;
    uint16_t deviation;
    uint16_t flags;
    float background_radiation;
} fake_attributes;

/*
 * The synthetic scan.
 *
 * PULSES pulses, of which every fifth returns twice. The counts are the
 * fixture's contract with the tests, and with fake_rxpshim.c — the reader
 * refuses to import a scan whose shot accounting does not reconcile, so the
 * two stubs have to agree:
 *
 *     shots (1200) == hit_shots (1000) + misses (200)
 *     shim echoes  == what this file emitted (1200)
 */
#define FAKE_PULSES 1000
#define FAKE_DOUBLE_EVERY 5
#define FAKE_ECHOES (FAKE_PULSES + FAKE_PULSES / FAKE_DOUBLE_EVERY)

/* 0.1 ms apart. Both echoes of a pulse share a timestamp — that IS how the
 * reader groups returns into pulses (targets_from_timestamps). */
#define FAKE_T0 1000000000ULL
#define FAKE_DT 100000ULL

static int pulse_echoes(int pulse) {
    return (pulse % FAKE_DOUBLE_EVERY == 0) ? 2 : 1;
}

typedef struct {
    int pulse; /* next pulse to emit */
    int sub;   /* which echo within it */
} fake_stream;

static char g_last_error[512] = "";

/*
 * Values are deliberately chosen to exercise the reader's column pruning,
 * which drops any column that is all-NaN or constant:
 *
 *   varying, so KEPT     reflectance, amplitude, deviation, echo_type, facet
 *   all NaN, so DROPPED  background_radiation
 *   constant, DROPPED    waveform_available, pseudo_echo, sw_calculated,
 *                        pps_locked
 *
 * A fixture where everything varies would pass while the pruning was broken.
 */
static void fill_point(int pulse, int sub, fake_xyz32 *p, fake_attributes *a,
                       uint64_t *t) {
    /* A second return is further along the same beam. */
    const double range = 10.0 + (pulse % 37) * 0.25 + (sub ? 3.5 : 0.0);
    const double az = (pulse % 360) * (3.14159265358979 / 180.0);
    const double el = ((pulse % 61) - 30) * (3.14159265358979 / 180.0);
    p->x = (float)(range * cos(el) * cos(az));
    p->y = (float)(range * cos(el) * sin(az));
    p->z = (float)(range * sin(el));

    a->amplitude = (float)(3.0 + (pulse % 17));
    a->reflectance = (float)(-20.0 + (pulse % 40) * 0.5);
    a->deviation = (uint16_t)(pulse % 11);
    a->background_radiation = (float)NAN;

    /* bits 0-1 echo type: 0 single, 1 first, 3 last. The reader cross-checks
     * this against its own timestamp grouping (validate_against_echo) and
     * reports a warning on disagreement, so the fixture has to be internally
     * consistent or it would be testing the warning instead of the grouping. */
    uint16_t echo_type;
    if (pulse_echoes(pulse) == 1) {
        echo_type = 0; /* single */
    } else {
        echo_type = (sub == 0) ? 1 : 3; /* first / last */
    }
    /* bit 7 pps_locked, constant on. bits 8-9 mirror facet, varying. */
    a->flags = (uint16_t)(echo_type | (1u << 7) | ((uint16_t)(pulse % 4) << 8));

    *t = FAKE_T0 + (uint64_t)pulse * FAKE_DT;
}

FAKE_API int scanifc_get_library_version(uint16_t *major, uint16_t *minor,
                                         uint16_t *build) {
    if (major) *major = 9;
    if (minor) *minor = 9;
    if (build) *build = 9;
    return 0;
}

FAKE_API int scanifc_get_last_error(char *buf, uint32_t size,
                                    uint32_t *written) {
    uint32_t n = (uint32_t)strlen(g_last_error);
    if (buf && size) {
        if (n >= size) n = size - 1;
        memcpy(buf, g_last_error, n);
        buf[n] = '\0';
    }
    if (written) *written = n;
    return 0;
}

/*
 * The URI is validated rather than ignored: `_uri()` prefixes "file:" and, on
 * Windows, hands over a native C:\... path. Rejecting anything else is what
 * makes this stub able to catch a "helpful" normalisation to file:/// — which
 * real RiVLib rejects, as measured.
 */
FAKE_API int scanifc_point3dstream_open(const char *uri, int sync_to_pps,
                                        void **handle) {
    (void)sync_to_pps;
    if (!uri || strncmp(uri, "file:", 5) != 0) {
        snprintf(g_last_error, sizeof g_last_error,
                 "fake scanifc: expected a 'file:' URI, got '%s'",
                 uri ? uri : "(null)");
        return -1;
    }
    if (strncmp(uri + 5, "//", 2) == 0) {
        snprintf(g_last_error, sizeof g_last_error,
                 "fake scanifc: real RiVLib rejects the file:// form; got '%s'",
                 uri);
        return -1;
    }
    FILE *f = fopen(uri + 5, "rb");
    if (!f) {
        snprintf(g_last_error, sizeof g_last_error,
                 "fake scanifc: no such file: %s", uri + 5);
        return -1;
    }
    fclose(f);

    fake_stream *s = (fake_stream *)calloc(1, sizeof *s);
    if (!s) return -1;
    *handle = s;
    return 0;
}

/*
 * Housekeeping records are a side effect of reading points in real RiVLib.
 * Writing them at add_demultiplexer time instead is a deliberate
 * simplification: the reader only ever parses the file after the read loop
 * finishes, so the observable behaviour is identical, and the GNSS/ENU path
 * gets covered without modelling the interleave.
 *
 * Field positions are the reader's contract (lon 5, lat 6, height 7), lon/lat
 * in nanodegrees and height in millimetres.
 */
FAKE_API int scanifc_point3dstream_add_demultiplexer(void *handle,
                                                     const char *filename,
                                                     const char *selections,
                                                     const char *classes) {
    (void)handle;
    (void)selections;
    (void)classes;
    if (!filename) return -1;
    FILE *f = fopen(filename, "w");
    if (!f) {
        snprintf(g_last_error, sizeof g_last_error,
                 "fake scanifc: cannot write %s", filename);
        return -1;
    }
    fprintf(f, "header (1.0), \"FAKE-1000\", \"none\", \"S0000001\"\n");
    /* 38.5368360 N, -121.7951283 E, 12.5 m — Davis, CA, so the ENU anchor
     * maths runs on a plausible fix rather than at null island. */
    for (int i = 0; i < 3; ++i) {
        fprintf(f,
                "hk_gps_hr (10020.0), 0, 0, 0, 0, 0, -121795128300, "
                "38536836000, 12500\n");
    }
    fprintf(f, "hk_incl (10006.0), -350, 120\n");
    fclose(f);
    return 0;
}

FAKE_API int scanifc_point3dstream_get_meta(void *handle, const char **json) {
    (void)handle;
    static const char *meta =
        "{\"pointcloud\": {\"type_id\": \"FAKE-1000\", \"serial\": "
        "\"S0000001\", \"wavelength\": 1.55e-06, \"pulse_repetition_rate\": "
        "300000.0, \"unambiguous_range\": 500.0}}";
    if (json) *json = meta;
    return 0;
}

FAKE_API int scanifc_point3dstream_read(void *handle, uint32_t want,
                                        fake_xyz32 *pxyz, fake_attributes *pattr,
                                        uint64_t *ptime, uint32_t *got,
                                        int32_t *end_of_frame) {
    fake_stream *s = (fake_stream *)handle;
    if (!s) return -1;

    uint32_t n = 0;
    while (n < want && s->pulse < FAKE_PULSES) {
        fake_xyz32 p;
        fake_attributes a;
        uint64_t t;
        fill_point(s->pulse, s->sub, &p, &a, &t);
        if (pxyz) pxyz[n] = p;
        if (pattr) pattr[n] = a;
        if (ptime) ptime[n] = t;
        ++n;

        if (++s->sub >= pulse_echoes(s->pulse)) {
            s->sub = 0;
            ++s->pulse;
        }
    }

    if (got) *got = n;
    /* The reader stops on got == 0 AND end_of_frame == 0, which is how real
     * RiVLib signals exhaustion. */
    if (end_of_frame) *end_of_frame = 0;
    return 0;
}

FAKE_API int scanifc_point3dstream_close(void *handle) {
    free(handle);
    return 0;
}
