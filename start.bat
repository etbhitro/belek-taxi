@echo off
rem Запуск прототипа: локальный сервер + страница в браузере. Окно не закрывать, пока пользуетесь.
cd /d "%~dp0"
start "" http://localhost:5510/
python -m http.server 5510
