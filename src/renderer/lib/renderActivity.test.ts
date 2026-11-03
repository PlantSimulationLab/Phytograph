import { describe, expect, it, vi } from 'vitest';
import { noteRenderActivity, onRenderActivity, trackedFetch } from './renderActivity';

describe('renderActivity', () => {
  it('stops telling a listener once it unsubscribes', () => {
    const listener = vi.fn();
    const stop = onRenderActivity(listener);
    noteRenderActivity();
    stop();
    noteRenderActivity();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports a fetch when it starts and again when it settles', async () => {
    const listener = vi.fn();
    const stop = onRenderActivity(listener);
    let finish!: (r: Response) => void;
    const pending = trackedFetch(() => new Promise<Response>((resolve) => { finish = resolve; }));
    expect(listener).toHaveBeenCalledTimes(1);
    finish(new Response('ok'));
    expect(await (await pending).text()).toBe('ok');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reports a failed fetch settling too, and still rejects', async () => {
    const listener = vi.fn();
    const stop = onRenderActivity(listener);
    await expect(trackedFetch(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});
