import { describe, expect, it } from 'vitest';
import {
  formatReticulumQAppDisplayLink,
  parseReticulumQAppLinks,
  resolveReticulumPreviewImageUrl,
} from './ReticulumQAppLinkPreview';

const qtubeLink =
  'qortal://APP/Q-Tube/video/Johnny%20Go%20Vroom/qtube_vid_grizzla-armor-for-the-lynx-s-t_wirangkppk_metadata';
const quitterLink =
  'qortal://APP/Quitter/post/igorcoin/MhNiRYdzkaP9dz-kX47dT-XrFXaYetyErMdF-vvQf5Ahb3N7jGgi-v1';
const subwireLink =
  'qortal://APP/SubWire/publication/JonahQ/7l1NGsWiY0SgPb-eEGFM7-T60ZadsfPsbLTh-53qmcEK52mrIPme-v1';

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
