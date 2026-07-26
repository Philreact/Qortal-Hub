export const returnToQChat = (
  setGroupSection: (section: string) => void,
  openQChat: () => void
): void => {
  setGroupSection('chat');
  openQChat();
};
