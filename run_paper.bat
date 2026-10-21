@echo off
chcp 65001 >nul
cd /d "D:\클로드\stock-secretary"
"C:\Users\pc\AppData\Local\Programs\Python\Python314\python.exe" paper_trader.py >> reports\paper_log.txt 2>&1
