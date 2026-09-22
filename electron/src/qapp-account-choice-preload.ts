import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  document
    .querySelectorAll<HTMLButtonElement>('[data-choice]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        ipcRenderer.send(
          'qapp-account-choice:select',
          button.dataset.choice === 'new'
            ? 'new'
            : Number(button.dataset.choice)
        );
      });
    });
  document
    .querySelectorAll<HTMLImageElement>('.avatar img')
    .forEach((image) => {
      const reveal = () => {
        if (image.naturalWidth > 0) image.classList.add('loaded');
      };
      if (image.complete) reveal();
      else image.addEventListener('load', reveal, { once: true });
    });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      ipcRenderer.send('qapp-account-choice:select', -1);
    }
  });
});
