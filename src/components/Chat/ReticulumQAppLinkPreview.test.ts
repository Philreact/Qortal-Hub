import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatReticulumQAppDisplayLink,
  getQuitterPostSummary,
  normalizeQTubeDescription,
  parseReticulumQAppLinks,
  ReticulumQAppLinkPreviews,
  resolveReticulumPreviewImageUrl,
} from './ReticulumQAppLinkPreview';

vi.mock('../../utils/globalApi', () => ({
  getBaseApiReact: () => 'http://localhost:12391',
}));

const qtubeLink =
  'qortal://APP/Q-Tube/video/Johnny%20Go%20Vroom/qtube_vid_grizzla-armor-for-the-lynx-s-t_wirangkppk_metadata';
const quitterLink =
  'qortal://APP/Quitter/post/igorcoin/MhNiRYdzkaP9dz-kX47dT-XrFXaYetyErMdF-vvQf5Ahb3N7jGgi-v1';
const subwireLink =
  'qortal://APP/SubWire/publication/JonahQ/7l1NGsWiY0SgPb-eEGFM7-T60ZadsfPsbLTh-53qmcEK52mrIPme-v1';
const missingQTubeLink =
  'qortal://APP/Q-Tube/video/Johnny%20Go%20Vroom/definitely-missing-metadata';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseReticulumQAppLinks', () => {
  it('recognizes the supported canonical Q-App routes', () => {
    const links = parseReticulumQAppLinks(
      `${qtubeLink}\n${quitterLink}\n${subwireLink}`
    );

    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      appName: 'Q-Tube',
      author: 'Johnny Go Vroom',
      identifier:
        'qtube_vid_grizzla-armor-for-the-lynx-s-t_wirangkppk_metadata',
      kind: 'qtube',
      path: 'video/Johnny%20Go%20Vroom/qtube_vid_grizzla-armor-for-the-lynx-s-t_wirangkppk_metadata',
    });
    expect(links[1]).toMatchObject({
      appName: 'Quitter',
      author: 'igorcoin',
      identifier: 'MhNiRYdzkaP9dz-kX47dT-XrFXaYetyErMdF-vvQf5Ahb3N7jGgi-v1',
      kind: 'quitter',
    });
    expect(links[2]).toMatchObject({
      appName: 'SubWire',
      author: 'JonahQ',
      identifier: '7l1NGsWiY0SgPb-eEGFM7-T60ZadsfPsbLTh-53qmcEK52mrIPme-v1',
      kind: 'subwire',
    });
  });

  it('rejects unsupported apps and mismatched routes', () => {
    expect(
      parseReticulumQAppLinks(
        [
          'qortal://APP/Q-Tube/post/name/id',
          'qortal://APP/Quitter/video/name/id',
          'qortal://APP/SubWire/post/name/id',
          'qortal://APP/Unknown/video/name/id',
        ].join(' ')
      )
    ).toEqual([]);
  });

  it('ignores links in code blocks, deduplicates links, and trims punctuation', () => {
    const links = parseReticulumQAppLinks(
      `<p>${quitterLink}).</p><pre>${qtubeLink}</pre><code>${subwireLink}</code><p>${quitterLink}</p>`
    );

    expect(links).toHaveLength(1);
    expect(links[0].link).toBe(quitterLink);
  });

  it('limits rich previews to three links per message', () => {
    const links = parseReticulumQAppLinks(
      [
        qtubeLink,
        quitterLink,
        subwireLink,
        'qortal://APP/Quitter/post/another-name/another-post',
      ].join(' ')
    );

    expect(links).toHaveLength(3);
  });
});

describe('formatReticulumQAppDisplayLink', () => {
  it('keeps the app and author prefix while eliding long identifiers', () => {
    const [quitter] = parseReticulumQAppLinks(quitterLink);
    const [subwire] = parseReticulumQAppLinks(subwireLink);

    expect(formatReticulumQAppDisplayLink(quitter)).toBe(
      'qortal://APP/Quitter/post/igorcoin/MhNiRYdzka(...)3N7jGgi-v1'
    );
    expect(formatReticulumQAppDisplayLink(subwire)).toBe(
      'qortal://APP/SubWire/author/JonahQ/7l1NGsWiY0(...)2mrIPme-v1'
    );
  });

  it('leaves short identifiers intact', () => {
    const [link] = parseReticulumQAppLinks(
      'qortal://APP/Q-Tube/video/JonahQ/short-video-id'
    );

    expect(formatReticulumQAppDisplayLink(link)).toBe(
      'qortal://APP/Q-Tube/video/JonahQ/short-video-id'
    );
  });
});

describe('resolveReticulumPreviewImageUrl', () => {
  it('uses SubWire embedded WebP cover payloads directly', () => {
    expect(
      resolveReticulumPreviewImageUrl(
        {
          name: 'article-cover.jpg',
          src: 'UklGRmVtYmVkZGVkLXdlYnA=',
        },
        'JonahQ',
        'publication-id'
      )
    ).toBe('data:image/webp;base64,UklGRmVtYmVkZGVkLXdlYnA=');
  });
});

describe('normalizeQTubeDescription', () => {
  it('replaces internal category metadata with the public fallback', () => {
    expect(
      normalizeQTubeDescription('**category:4;subcategory:499;code:9psFj**')
    ).toBe('Watch this video on Q-Tube.');
  });

  it('keeps a real description while removing trailing internal metadata', () => {
    expect(
      normalizeQTubeDescription(
        'A useful video. **category:4;subcategory:499;code:9psFj**'
      )
    ).toBe('A useful video.');
  });

  it('uses the same fallback for an empty description', () => {
    expect(normalizeQTubeDescription('')).toBe('Watch this video on Q-Tube.');
  });
});

describe('getQuitterPostSummary', () => {
  it('uses the post text when one is present', () => {
    expect(
      getQuitterPostSummary({
        text: 'A normal Quitter post',
        images: [{ name: 'photo.webp' }],
      })
    ).toBe('A normal Quitter post');
  });

  it('identifies an image-only post as a photo', () => {
    expect(
      getQuitterPostSummary({
        text: '',
        images: [{ name: 'photo.webp' }],
        videos: [],
      })
    ).toBe('Shared a photo');
  });

  it('identifies a video-only post and keeps an available title', () => {
    expect(
      getQuitterPostSummary(
        {
          text: '',
          images: [],
          videos: [{ identifier: 'video-metadata' }],
        },
        'A Q-Tube video'
      )
    ).toBe('Shared a video: A Q-Tube video');
  });

  it('uses a neutral fallback when the post has no text or media', () => {
    expect(getQuitterPostSummary({ text: '', images: [], videos: [] })).toBe(
      'View this post on Quitter'
    );
  });
});

describe('ReticulumQAppLinkPreviews', () => {
  it('removes the loading preview when its request times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options?: RequestInit) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const { container } = render(
      createElement(ReticulumQAppLinkPreviews, { source: qtubeLink })
    );
    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(container.querySelector('.MuiSkeleton-root')).toBeNull();
    expect(screen.getByText('Preview unavailable')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /qortal:\/\/APP\/Q-Tube/i })
    ).toBeVisible();
  });

  it('can retry a failed preview request without removing its shell', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'Johnny Go Vroom' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ title: 'Recovered video' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    render(
      createElement(ReticulumQAppLinkPreviews, { source: missingQTubeLink })
    );
    await waitFor(() =>
      expect(screen.getByText('Preview unavailable')).toBeVisible()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByText('Recovered video')).toBeVisible()
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('distinguishes a missing resource from a metadata fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
    );

    render(createElement(ReticulumQAppLinkPreviews, { source: qtubeLink }));

    await waitFor(() =>
      expect(screen.getByText('Resource not found')).toBeVisible()
    );
    expect(
      screen.getByText('No Q-App resource was found for this link.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open in Q-Tube' })).toBeNull();
  });
});
