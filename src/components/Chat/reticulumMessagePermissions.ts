type ReticulumMessagePermissionInput = {
  isOfficialGroupWelcome: boolean;
  message?: {
    reticulumChat?: unknown;
    sender?: unknown;
  } | null;
  myAddress: string;
};

export function canEditOwnReticulumMessage({
  isOfficialGroupWelcome,
  message,
  myAddress,
}: ReticulumMessagePermissionInput): boolean {
  return (
    message?.sender === myAddress &&
    !isOfficialGroupWelcome &&
    message?.reticulumChat === true
  );
}
