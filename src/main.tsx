import '@fontsource-variable/unbounded';
import '@fontsource-variable/manrope';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

// Защита от clickjacking там, где нельзя задать заголовок X-Frame-Options / frame-ancestors (GitHub Pages):
// если игра открыта внутри чужой страницы-фрейма, скрываем её и пробуем выйти из фрейма. Игре встраивание не нужно.
const framed = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true; // доступ к top запрещён — мы точно во фрейме другого происхождения
  }
})();
if (framed) {
  document.documentElement.style.display = 'none';
  try {
    window.top!.location.href = window.self.location.href;
  } catch {
    // переход запрещён браузером — игра останется скрытой
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
