export type QortalLandRoomAssetPlacement<RoomId extends string> = {
  assetId: string;
  roomIds?: readonly RoomId[];
};

export const collectQortalLandRoomAssetIds = <RoomId extends string>({
  roomId,
  defaultRoomId,
  placements,
  extraAssetIdsByRoom,
}: {
  roomId: RoomId;
  defaultRoomId: RoomId;
  placements: readonly QortalLandRoomAssetPlacement<RoomId>[];
  extraAssetIdsByRoom: Partial<Record<RoomId, readonly string[]>>;
}): string[] => {
  const assetIds = new Set<string>();
  for (const placement of placements) {
    const roomIds = placement.roomIds ?? [defaultRoomId];
    if (roomIds.includes(roomId)) assetIds.add(placement.assetId);
  }
  for (const assetId of extraAssetIdsByRoom[roomId] ?? []) {
    assetIds.add(assetId);
  }
  return Array.from(assetIds);
};
