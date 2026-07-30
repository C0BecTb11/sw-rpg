// Подключение к Supabase. Ключи тут одни на весь проект —
// меняешь один раз в этом файле, если понадобится (например при смене проекта).

var SUPABASE_URL = 'https://zqqaxhhajhgspaiwlyhy.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxcWF4aGhhamhnc3BhaXdseWh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NDMyNjIsImV4cCI6MjEwMTAxOTI2Mn0.oauDY1aq02uU1dHsoj_H50fi4owBDypn_hMHDalHOSw';

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
