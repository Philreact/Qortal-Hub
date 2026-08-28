import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { Box, Typography, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AppsWidthLimiter } from '../Apps-styles';
import { AppCardEnhanced } from '../AppCard';
import { SortOption, StatusFilterOption } from '../Filters';
import { officialAppList } from '../config/officialApps';
import { filterAndSortApps } from '../../../atoms/appsAtoms';
import { ratingsStoreAtom } from '../../../hooks/useAppRatings';
import type { AppRatingData } from '../../../types/ratings';

const CARD_MIN_WIDTH = 320;
const GRID_GAP = 16;
const CARD_HEIGHT = 220;
const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP;
const EMPTY_RATINGS_MAP = new Map<string, AppRatingData>();

interface CommunityAppsTabProps {
  availableQapps: any[];
  myName: string;
  searchValue: string;
  sortValue: SortOption;
  categoryValue: string;
  statusValue: StatusFilterOption;
  scrollParent?: HTMLElement | null;
}

export const CommunityAppsTab = ({
  availableQapps,
  myName,
  searchValue,
  sortValue,
  categoryValue,
  statusValue,
  scrollParent,
}: CommunityAppsTabProps) => {
  const theme = useTheme();
  const { t } = useTranslation(['core']);
  const isRatingSort =
    sortValue === 'highest_rated' || sortValue === 'most_rated';
  const ratingsForSortAtom = useMemo(
    () =>
      atom((get) => (isRatingSort ? get(ratingsStoreAtom) : EMPTY_RATINGS_MAP)),
    [isRatingSort]
  );
  const ratingsStore = useAtomValue(ratingsForSortAtom);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  // Filter out official apps to show only community apps
  const communityApps = useMemo(() => {
    return availableQapps.filter(
      (app) => !officialAppList.includes(app?.name?.toLowerCase())
    );
  }, [availableQapps]);

  // Apply all filters and sorting (ratings-aware)
  const filteredAndSortedApps = useMemo(() => {
    return filterAndSortApps(communityApps, {
      sort: sortValue,
      category: categoryValue,
      status: statusValue,
      search: searchValue,
      ratingsMap: ratingsStore,
    });
  }, [
    communityApps,
    searchValue,
    categoryValue,
    statusValue,
    sortValue,
    ratingsStore,
  ]);

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;

    const updateWidth = () => {
      setGridWidth(element.getBoundingClientRect().width);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columnCount = useMemo(() => {
    if (gridWidth <= 0) return 1;
    return Math.max(
      1,
      Math.floor((gridWidth + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))
    );
  }, [gridWidth]);

  const rowCount = Math.ceil(filteredAndSortedApps.length / columnCount);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParent ?? null,
    estimateSize: useCallback(() => ROW_HEIGHT, []),
    getItemKey: useCallback(
      (index: number) => {
        const firstApp = filteredAndSortedApps[index * columnCount];
        return `${columnCount}-${firstApp?.service ?? ''}-${firstApp?.name ?? index}`;
      },
      [columnCount, filteredAndSortedApps]
    ),
    overscan: 5,
  });

  return (
    <AppsWidthLimiter sx={{ flex: 1, minHeight: 0 }}>
      {filteredAndSortedApps.length > 0 ? (
        <Box ref={gridRef} sx={{ width: '100%', paddingBottom: '20px' }}>
          <Box
            sx={{
              height: rowVirtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const rowStart = virtualRow.index * columnCount;
              const rowApps = filteredAndSortedApps.slice(
                rowStart,
                rowStart + columnCount
              );

              return (
                <Box
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  sx={{
                    display: 'grid',
                    gap: `${GRID_GAP}px`,
                    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                    left: 0,
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: '100%',
                  }}
                >
                  {rowApps.map((app) => (
                    <AppCardEnhanced
                      key={`${app?.service}-${app?.name}`}
                      app={app}
                      myName={myName}
                    />
                  ))}
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            padding: '40px',
          }}
        >
          <Typography sx={{ color: theme.palette.text.secondary }}>
            {t('core:message.generic.no_results', {
              postProcess: 'capitalizeFirstChar',
            })}
          </Typography>
        </Box>
      )}
    </AppsWidthLimiter>
  );
};
