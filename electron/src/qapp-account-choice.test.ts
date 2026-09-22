import { describe, expect, it } from 'vitest';
import {
  qAppAccountChoiceText,
  renderQAppAccountChoiceHtml,
} from './qapp-account-choice';

describe('Q-App account chooser labels', () => {
  it('shows the account name, shortened address, and instance', async () => {
    const labels = await qAppAccountChoiceText('en-US', 'Q-Tube');
    expect(labels.message).toBe('Open Q-Tube with which account?');
    expect(
      labels.accountLabel({
        port: 55001,
        instance: 1,
        name: 'Alice',
        address: 'Qabc12…wxyz',
      })
    ).toBe('Alice · Qabc12…wxyz · Hub 2');
  });

  it('uses a localized fallback for an instance without an account name', async () => {
    const labels = await qAppAccountChoiceText('de-DE', 'Q-Tube');
    expect(labels.cancel).toBe('Abbrechen');
    expect(labels.accountLabel({ port: 55000, instance: 0 })).toBe('Hub 1');
  });

  it('renders account rows with avatars and escapes account data', async () => {
    const labels = await qAppAccountChoiceText('en-US', 'Q-Tube');
    const html = renderQAppAccountChoiceHtml(labels, [
      {
        port: 55000,
        instance: 0,
        name: 'Alice <script>',
        address: 'Qabc12…wxyz',
        avatarUrl: 'https://node.example/avatar?a=1&b=2',
      },
      { port: 55001, instance: 1, name: 'Bob' },
    ]);
    expect(html).toContain('Alice &lt;script&gt;');
    expect(html).not.toContain('Alice <script>');
    expect(html).toContain('src="https://node.example/avatar?a=1&amp;b=2"');
    expect(html).toContain('data-choice="0"');
    expect(html).toContain('data-choice="1"');
    expect(html).toContain('Hub 2');
    expect(html).toContain('data-choice="new"');
    expect(html).toContain('Use another account');
  });

  it('shows the Hub launcher action for a repeat desktop launch', async () => {
    const labels = await qAppAccountChoiceText('en-US');
    expect(labels.message).toBe('Which Hub would you like to open?');
    expect(labels.newInstance).toBe('Open another Hub');
  });
});
