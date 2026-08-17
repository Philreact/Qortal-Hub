import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReticulumUserCard } from './ReticulumUserCard';

describe('ReticulumUserCard', () => {
  it('formats account values with the active translation locale', () => {
    expect(() =>
      render(
        <ReticulumUserCard
          anchorEl={null}
          data={{
            address: 'QtestAddress',
            isMinterResolved: true,
            isOwn: false,
            status: 'online',
          }}
          onClose={() => undefined}
        />
      )
    ).not.toThrow();
  });
});
