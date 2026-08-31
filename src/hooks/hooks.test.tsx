// @vitest-environment jsdom
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreddaProvider } from '../components/CreddaProvider.js';
import { useInvestigation } from './useInvestigation.js';
import { useInvestigationEvents } from './useInvestigationEvents.js';
import { useInvestigations } from './useInvestigations.js';
import { useResolution } from './useResolution.js';
import { useValidation } from './useValidation.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An SSE response whose frames can be pushed after the stream is open. */
function liveSse(): { response: Response; push: (id: number, type: string, data: unknown) => void; close: () => void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (id, type, data) =>
      controller.enqueue(encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => controller.close(),
  };
}

function wrapper(fetchImpl: unknown) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CreddaProvider baseUrl="https://engine.example.com" apiKey="crd_k" fetch={fetchImpl as never}>
        {children}
      </CreddaProvider>
    );
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CreddaProvider', () => {
  it('refuses to serve a client to a hook mounted outside it', () => {
    function Orphan() {
      useInvestigations();
      return null;
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Orphan />)).toThrow(/useCreddaClient must be used inside <CreddaProvider>/);
    consoleError.mockRestore();
  });
});

describe('useInvestigations', () => {
  function List({ state }: { state?: 'REPRODUCED' }) {
    const { investigations, total, loading, error } = useInvestigations(state ? { state } : {});
    if (loading) return <span>loading</span>;
    if (error) return <span>error: {error.message}</span>;
    return (
      <span>
        {investigations.map((i) => i.issueTitle).join(',')} of {total}
      </span>
    );
  }

  it('reads a page and reports the total apart from the page', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ investigations: [{ id: 'inv_1', issueTitle: 'Checkout 500s' }], total: 41 }),
    );
    render(<List />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText(/of 41/)).toBeTruthy());
    expect(screen.getByText(/Checkout 500s/)).toBeTruthy();
  });

  it('surfaces a refusal as an error rather than an empty list', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid API key' } }, 401),
    );
    render(<List />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText(/Invalid API key/)).toBeTruthy());
  });

  it('refetches when the filter changes, and not on an unrelated re-render', async () => {
    const fetchImpl = vi.fn(async () => json({ investigations: [], total: 0 }));
    const { rerender } = render(<List />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    rerender(<List />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    rerender(<List state="REPRODUCED" />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown[];
    expect(String(lastCall[0])).toContain('state=REPRODUCED');
  });
});

describe('useInvestigation', () => {
  function Detail({ id }: { id: string | null }) {
    const { data, loading } = useInvestigation(id);
    if (loading) return <span>loading</span>;
    return <span>{data === null ? 'none' : data.investigation.state}</span>;
  }

  it('reads one investigation', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        investigation: { id: 'inv_1', state: 'REPRODUCED_AND_DIAGNOSED' },
        hypotheses: [],
        patches: [],
        verifications: [],
        evidenceCount: 3,
        latestSequence: 12,
      }),
    );
    render(<Detail id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('REPRODUCED_AND_DIAGNOSED')).toBeTruthy());
  });

  it('requests nothing at all for a null id', async () => {
    const fetchImpl = vi.fn(async () => json({}));
    render(<Detail id={null} />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('none')).toBeTruthy());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('useResolution', () => {
  function Record({ id }: { id: string }) {
    const { resolution, loading, error } = useResolution(id);
    if (loading) return <span>loading</span>;
    if (error) return <span>error</span>;
    if (resolution === null) return <span>nothing established yet</span>;
    return <span>{resolution.confidence.class}</span>;
  }

  it('renders a null record as "no record yet", not as a missing page', async () => {
    // The distinction the route exists to preserve: a null resolution means the
    // investigation resolved nothing, and a 404 means the id was wrong.
    const fetchImpl = vi.fn(async () => json({ resolution: null }));
    render(<Record id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('nothing established yet')).toBeTruthy());
  });

  it('renders an unknown investigation as an error', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: 'NOT_FOUND', message: 'No such investigation: inv_x' } }, 404),
    );
    render(<Record id="inv_x" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('error')).toBeTruthy());
  });

  it('carries the confidence class through', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ resolution: { id: 'res_1', confidence: { class: 'PARTIALLY_ESTABLISHED', notEstablished: ['no fix was written'] } } }),
    );
    render(<Record id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('PARTIALLY_ESTABLISHED')).toBeTruthy());
  });
});

describe('useValidation', () => {
  it('exposes the check count on the detail, where a zero-check success is visible', async () => {
    function Run() {
      const { data } = useValidation('val_1');
      return <span>{data === null ? '…' : `${data.validation.outcome}/${data.checkCount}`}</span>;
    }
    const fetchImpl = vi.fn(async () =>
      json({
        validation: { id: 'val_1', outcome: 'VERIFIED' },
        environment: { status: 'READY', failureKind: null, detail: {} },
        changeImpact: {},
        checkCount: 0,
        findingCount: 0,
        evidenceCount: 0,
        latestSequence: 0,
      }),
    );
    render(<Run />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('VERIFIED/0')).toBeTruthy());
  });
});

describe('useInvestigationEvents', () => {
  function Timeline({ id }: { id: string }) {
    const { events, latestSequence, streaming, error } = useInvestigationEvents(id, { reconnect: false });
    return (
      <span>
        {streaming ? 'live' : 'closed'}:{latestSequence}:{events.map((e) => e.type).join(',')}
        {error ? `:${error.message}` : ''}
      </span>
    );
  }

  it('appends events as they arrive and tracks the cursor', async () => {
    const live = liveSse();
    const fetchImpl = vi.fn(async () => live.response);
    render(<Timeline id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText(/^live:0:/)).toBeTruthy());

    await act(async () => {
      live.push(4, 'REPRODUCTION_SUCCEEDED', { sequence: 4, type: 'REPRODUCTION_SUCCEEDED' });
      live.push(5, 'ROOT_CAUSE_IDENTIFIED', { sequence: 5, type: 'ROOT_CAUSE_IDENTIFIED' });
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() =>
      expect(screen.getByText('live:5:REPRODUCTION_SUCCEEDED,ROOT_CAUSE_IDENTIFIED')).toBeTruthy(),
    );

    await act(async () => {
      live.close();
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(screen.getByText(/^closed:5:/)).toBeTruthy());
  });

  it('reports a revoked key through error and stops streaming', async () => {
    const live = liveSse();
    const fetchImpl = vi.fn(async () => live.response);
    render(<Timeline id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText(/^live:/)).toBeTruthy());

    await act(async () => {
      live.push(1, 'unauthenticated', { reason: 'the API key for this stream was revoked' });
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() =>
      expect(screen.getByText(/closed:.*the API key for this stream was revoked/)).toBeTruthy(),
    );
  });

  /*
   * The default here is `reconnect: true`, which is what makes this the case
   * that mattered: a finished run was indistinguishable from a quiet one, the
   * subscription reopened every time the server closed it, and a mounted
   * component watched a run that had been over for hours. `WatchedTimeline`
   * takes the default deliberately.
   */
  it('ends on the complete frame and reports the terminal state, without reopening', async () => {
    function WatchedTimeline({ id }: { id: string }) {
      const { streaming, completedState } = useInvestigationEvents(id);
      return (
        <span>
          {streaming ? 'live' : 'closed'}:{completedState ?? 'in-flight'}
        </span>
      );
    }
    const live = liveSse();
    const fetchImpl = vi.fn(async () => live.response);
    render(<WatchedTimeline id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(screen.getByText('live:in-flight')).toBeTruthy());

    await act(async () => {
      live.push(7, 'complete', { state: 'READY_FOR_REVIEW' });
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(screen.getByText('closed:READY_FOR_REVIEW')).toBeTruthy());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts the stream when the component unmounts', async () => {
    const live = liveSse();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return live.response;
    });
    const { unmount } = render(<Timeline id="inv_1" />, { wrapper: wrapper(fetchImpl) });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
