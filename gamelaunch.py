import sys
import subprocess
import psutil

def main():
    args = sys.argv[1:]
    if not args:
        return

    # 启动Java进程
    proc = subprocess.Popen(args)

    # 提升进程优先级（游戏优化）
    try:
        p = psutil.Process(proc.pid)
        p.nice(psutil.HIGH_PRIORITY_CLASS)
    except Exception:
        pass

    proc.wait()

if __name__ == "__main__":
    main()
