// Flat C surface over RiVLib's C++ scanlib::pointcloud, for reading the
// NO-RETURN shots that the plain C `scanifc` API cannot see.
//
// WHY THIS EXISTS
// ---------------
// An .rxp records returns. Shots that hit nothing are not stored as points at
// all, so `scanifc_point3dstream_read` — the C API the rest of the reader uses
// — simply never mentions them. But LAD needs exactly those rays: they are the
// transmission term in Beer's law, and they are ~46% of a real scan
// (7,518,052 of 18,199,111 shots on the reference position).
//
// The C++ `pointcloud` class does surface them. `on_shot_end()` is invoked for
// EVERY laser shot, including ones with no echoes, and `beam_direction` holds
// that shot's true unit vector. So a no-return shot is `target_count == 0` at
// on_shot_end, which is also how PDAL implements its `emitEmptyShots` option.
//
// NOT on_gap(). The documentation describes on_gap() as "callback for detected
// gaps, i.e. shot without echo return", which reads like the obvious answer.
// Measured on real VZ-1000 data it fires ZERO times while 7.5 M shots end with
// target_count == 0. Building on it would have silently recovered nothing.
// PDAL does not implement on_gap() either.
//
// WHY A C++ SHIM AND NOT CTYPES
// -----------------------------
// Receiving these callbacks means subclassing `pointcloud` and overriding
// virtuals — that needs a vtable, which ctypes cannot construct. So the
// subclass lives here and exposes a flat C entry point that ctypes can call.
// RiVLib's own docs recommend this shape ("consider writing an intermediary dll
// using a C++ compiler that interfaces to RiVLib internally and exposes a plain
// C interface").
//
// ABI: libscanifc.so is built with gcc 9.5.0 (__cxx11 ABI) and this compiles
// with the image's gcc 10. That combination is verified working on real data:
// the C++ path independently reproduces the ctypes reader's echo count
// (13,083,685) and pulse count (10,681,059) exactly.
//
// The class is linked from libscanifc.so — the same shared object the ctypes
// reader already loads — so no static lib is needed.

#include <riegl/scanlib.hpp>

#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <vector>

using namespace scanlib;

namespace {

// Collects the beam direction and timestamp of every no-return shot.
//
// Only misses are accumulated. The hits still come through the C API on the
// existing path: it is already fast (~5.7 s for 13 M points), well tested, and
// duplicating it here would mean two decoders that could disagree.
class MissCollector : public pointcloud {
public:
    std::vector<double> dirs;   // 3 per miss, unit vectors, scanner frame
    std::vector<double> times;  // 1 per miss, seconds
    unsigned long long shots = 0;
    unsigned long long shots_with_returns = 0;
    unsigned long long echoes = 0;

    MissCollector() : pointcloud(false) {}

protected:
    void on_shot() override {
        pointcloud::on_shot();
        ++shots;
    }

    void on_shot_end() override {
        pointcloud::on_shot_end();
        if (target_count == 0) {
            // A no-return shot. `beam_direction` is a unit vector in the
            // scanner's own frame; the caller turns it into a point.
            dirs.push_back(beam_direction[0]);
            dirs.push_back(beam_direction[1]);
            dirs.push_back(beam_direction[2]);
            times.push_back(time_sorg);
            return;
        }
        ++shots_with_returns;
        echoes += static_cast<unsigned long long>(target_count);
    }
};

struct Result {
    MissCollector pc;
    std::string error;
};

}  // namespace

extern "C" {

// Read one .rxp and collect its no-return shots.
//
// Returns an opaque handle (never null). The caller must check
// rxpshim_error() and then free with rxpshim_free().
void* rxpshim_collect_misses(const char* uri) {
    Result* r = new (std::nothrow) Result();
    if (r == nullptr) return nullptr;
    try {
        std::shared_ptr<basic_rconnection> rc = basic_rconnection::create(uri);
        rc->open();
        decoder_rxpmarker dec(rc);
        buffer buf;
        for (dec.get(buf); !dec.eoi(); dec.get(buf)) {
            r->pc.dispatch(buf.begin(), buf.end());
        }
        rc->close();
    } catch (const std::exception& e) {
        r->error = e.what();
    } catch (...) {
        r->error = "unknown exception in RiVLib";
    }
    return r;
}

// Empty string when the read succeeded.
const char* rxpshim_error(void* h) {
    if (h == nullptr) return "allocation failed";
    return static_cast<Result*>(h)->error.c_str();
}

uint64_t rxpshim_miss_count(void* h) {
    if (h == nullptr) return 0;
    return static_cast<Result*>(h)->pc.times.size();
}

uint64_t rxpshim_shot_count(void* h) {
    if (h == nullptr) return 0;
    return static_cast<Result*>(h)->pc.shots;
}

uint64_t rxpshim_hit_shot_count(void* h) {
    if (h == nullptr) return 0;
    return static_cast<Result*>(h)->pc.shots_with_returns;
}

uint64_t rxpshim_echo_count(void* h) {
    if (h == nullptr) return 0;
    return static_cast<Result*>(h)->pc.echoes;
}

// Copy the collected arrays out. `dirs` needs 3 * miss_count doubles,
// `times` needs miss_count. Either may be null to skip it.
void rxpshim_copy(void* h, double* dirs, double* times) {
    if (h == nullptr) return;
    Result* r = static_cast<Result*>(h);
    if (dirs != nullptr && !r->pc.dirs.empty()) {
        std::memcpy(dirs, r->pc.dirs.data(), r->pc.dirs.size() * sizeof(double));
    }
    if (times != nullptr && !r->pc.times.empty()) {
        std::memcpy(times, r->pc.times.data(), r->pc.times.size() * sizeof(double));
    }
}

void rxpshim_free(void* h) {
    delete static_cast<Result*>(h);
}

}  // extern "C"
