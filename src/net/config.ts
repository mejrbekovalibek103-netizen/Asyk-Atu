/**
 * Настройки онлайн-режима. Отдельный маленький модуль без зависимостей: его можно импортировать
 * из любого экрана, не подтягивая библиотеку Supabase в основной файл игры.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Онлайн включён в этой сборке (заданы адрес проекта и публичный ключ). */
export const onlineAvailable = !!(SUPABASE_URL && SUPABASE_KEY);
