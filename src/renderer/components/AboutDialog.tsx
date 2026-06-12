import { useState, useEffect } from 'react';
import { X, Github } from 'lucide-react';
import { REPO_URL } from '../../shared/constants';
import logoImage from '../assets/logo.png';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AboutInfo {
  appVersion: string;
  backendVersion: string;
  pyheliosVersion: string;
  heliosVersion: string;
  platform: string;
}

// Replaces Electron's native About panel (which would show the Electron
// framework logo + Electron's own version). Every version shown here is read
// from a live source — app/backend from the IPC BackendInfo, and the two
// submodule versions from a file generated at build time by
// scripts/gen-version-info.mjs — so there's nothing to hand-maintain when a
// version is bumped.
export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void window.electronAPI.backend
      .getInfo()
      .then((i) => {
        if (cancelled) return;
        setInfo({
          appVersion: i.appVersion,
          backendVersion: i.expectedVersion,
          pyheliosVersion: i.pyheliosVersion,
          heliosVersion: i.heliosVersion,
          platform: i.platform,
        });
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const rows: { label: string; value: string }[] = info
    ? [
        { label: 'Application', value: info.appVersion },
        { label: 'Backend', value: info.backendVersion },
        { label: 'PyHelios', value: info.pyheliosVersion },
        { label: 'Helios (C++)', value: info.heliosVersion },
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="about-dialog"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-sm mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-end px-2 py-2 border-b border-neutral-700 bg-neutral-800/90">
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="px-6 pb-6 pt-2 flex flex-col items-center">
          <img src={logoImage} alt="Phytograph" className="w-20 h-20 object-contain mb-3" />
          <h2 className="text-lg font-semibold text-white">Phytograph</h2>
          {info && (
            <p className="text-[11px] text-neutral-500 mb-4">{info.platform}</p>
          )}

          <div className="w-full space-y-1.5">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between text-xs border-b border-neutral-700/50 pb-1.5"
              >
                <span className="text-neutral-400">{r.label}</span>
                <span
                  data-testid={`about-version-${r.label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`}
                  className="font-mono text-neutral-200"
                >
                  {r.value}
                </span>
              </div>
            ))}
            {!info && (
              <p className="text-xs text-neutral-500 text-center py-2">Loading version info…</p>
            )}
          </div>

          <button
            onClick={() => void window.electronAPI.shell.openExternal(REPO_URL)}
            className="mt-5 w-full px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-100 rounded-lg flex items-center justify-center gap-2 transition-colors text-sm"
          >
            <Github className="w-4 h-4" />
            Phytograph on GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
