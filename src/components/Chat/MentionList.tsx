import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import KeyboardReturnRoundedIcon from '@mui/icons-material/KeyboardReturnRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import { useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { MentionSuggestionItem } from './TipTap';

type MentionListProps = {
  command: (item: MentionSuggestionItem) => void;
  items: MentionSuggestionItem[];
};

type MentionListHandle = {
  onKeyDown: ({ event }: { event: KeyboardEvent }) => boolean;
};

const SECTION_LABEL_KEYS: Record<MentionSuggestionItem['section'], string> = {
  people: 'group:reticulum.mention.people',
  special: 'group:reticulum.mention.special',
  channels: 'group:reticulum.mention.channels',
};

const SECTION_ORDER: MentionSuggestionItem['section'][] = [
  'people',
  'special',
  'channels',
];

const MentionList = forwardRef<MentionListHandle, MentionListProps>(
  ({ command, items }, ref) => {
    const theme = useTheme();
    const { t } = useTranslation(['group']);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const groupedItems = useMemo(
      () =>
        SECTION_ORDER.map((section) => ({
          section,
          items: items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.section === section),
        })).filter((group) => group.items.length > 0),
      [items]
    );

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) command(item);
    };

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          if (items.length > 0) {
            setSelectedIndex(
              (current) => (current + items.length - 1) % items.length
            );
          }
          return true;
        }

        if (event.key === 'ArrowDown') {
          if (items.length > 0) {
            setSelectedIndex((current) => (current + 1) % items.length);
          }
          return true;
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
          if (items.length > 0) selectItem(selectedIndex);
          return items.length > 0;
        }

        return false;
      },
    }));

    return (
      <div
        aria-label={t('group:reticulum.mention.suggestions', {
          postProcess: 'capitalizeFirstChar',
        })}
        className="qchat-mention-menu"
        data-color-mode={theme.palette.mode}
        role="listbox"
      >
        <div className="qchat-mention-menu__scroll">
          {items.length > 0 ? (
            groupedItems.map(({ section, items: sectionItems }) => (
              <section className="qchat-mention-menu__section" key={section}>
                <div className="qchat-mention-menu__section-label">
                  {t(SECTION_LABEL_KEYS[section], {
                    postProcess: 'capitalizeEachFirstChar',
                  })}
                </div>
                {sectionItems.map(({ item, index }) => {
                  const selected = index === selectedIndex;
                  const visibleLabel =
                    item.kind === 'channel' &&
                    item.iconText &&
                    item.label.trimStart().startsWith(item.iconText)
                      ? item.label
                          .trimStart()
                          .slice(item.iconText.length)
                          .trimStart()
                      : item.label;
                  return (
                    <button
                      aria-selected={selected}
                      className={`qchat-mention-menu__row qchat-mention-menu__row--${item.kind}${
                        selected ? ' is-selected' : ''
                      }`}
                      key={`${item.kind}:${item.id}`}
                      onClick={() => selectItem(index)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      role="option"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`qchat-mention-menu__icon qchat-mention-menu__icon--${item.kind}`}
                      >
                        {item.kind === 'person' ? (
                          <PersonRoundedIcon />
                        ) : item.kind === 'here' ||
                          item.kind === 'everyone' ||
                          item.kind === 'group' ? (
                          <GroupsRoundedIcon />
                        ) : (
                          <span>{item.iconText || '@'}</span>
                        )}
                      </span>
                      <span className="qchat-mention-menu__copy">
                        <span className="qchat-mention-menu__primary">
                          {visibleLabel}
                        </span>
                        <span className="qchat-mention-menu__secondary">
                          {item.description}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="qchat-mention-menu__accept"
                      >
                        {selected ? <KeyboardReturnRoundedIcon /> : null}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))
          ) : (
            <div className="qchat-mention-menu__empty">
              {t('group:reticulum.mention.empty', {
                postProcess: 'capitalizeFirstChar',
              })}
            </div>
          )}
        </div>
      </div>
    );
  }
);

MentionList.displayName = 'MentionList';

export default MentionList;
