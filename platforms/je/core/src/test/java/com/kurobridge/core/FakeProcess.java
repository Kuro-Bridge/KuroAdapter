package com.kurobridge.core;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 测试用假 Node 进程（无需真实 node）：
 *
 * <ul>
 *   <li>stdout / stderr：{@link StdoutStream} 可增量喂帧，closeWrite() 模拟进程退出时的管道 EOF。</li>
 *   <li>stdin：{@link CapturingStdin} 把 NodeIpc 写入的字节按行捕获（UTF-8），close() 模拟
 *       「stdin EOF → Node 自杀」（决策 D-08）。</li>
 *   <li>stubborn 模式：destroy / destroyForcibly / stdin EOF 均不退出（模拟僵尸进程，验证
 *       shutdown 的有界性）。</li>
 * </ul>
 */
final class FakeProcess extends Process {
    final StdoutStream stdout = new StdoutStream();
    final StdoutStream stderr = new StdoutStream();
    final CapturingStdin stdin = new CapturingStdin();

    private final CountDownLatch exitLatch = new CountDownLatch(1);
    private volatile boolean alive = true;
    private volatile int exitCode;
    private volatile boolean stubborn;

    /** 由 ProcessFactory lambda 记录的启动参数。 */
    volatile List<String> command;

    volatile Map<String, String> extraEnv;

    volatile Path workingDirectory;

    FakeProcess() {
        stdin.onClose(() -> {
            if (!stubborn) {
                exit(0);
            }
        });
    }

    void setStubborn(boolean stubborn) {
        this.stubborn = stubborn;
    }

    /** 模拟进程退出（关闭输出管道，使读取端读到 EOF）。 */
    void exit(int code) {
        if (!alive) {
            return;
        }
        alive = false;
        exitCode = code;
        exitLatch.countDown();
        stdout.closeWrite();
        stderr.closeWrite();
    }

    @Override
    public OutputStream getOutputStream() {
        return stdin;
    }

    @Override
    public InputStream getInputStream() {
        return stdout;
    }

    @Override
    public InputStream getErrorStream() {
        return stderr;
    }

    @Override
    public int waitFor() throws InterruptedException {
        exitLatch.await();
        return exitCode;
    }

    @Override
    public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
        return exitLatch.await(timeout, unit);
    }

    @Override
    public int exitValue() {
        if (alive) {
            throw new IllegalThreadStateException("process still alive");
        }
        return exitCode;
    }

    @Override
    public void destroy() {
        if (!stubborn) {
            exit(0);
        }
    }

    @Override
    public Process destroyForcibly() {
        if (!stubborn) {
            exit(137);
        }
        return this;
    }

    @Override
    public boolean isAlive() {
        return alive;
    }

    @Override
    public long pid() {
        return 424_242L;
    }

    @Override
    public boolean supportsNormalTermination() {
        return true;
    }

    /** 可增量写入、阻塞读取的字节流（替代 PipedInputStream，避免其线程存活性探测的不确定性）。 */
    static final class StdoutStream extends InputStream {
        private final BlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
        private ByteArrayInputStream current;
        private boolean eof;
        private volatile boolean readerClosed;

        /** 按行喂帧：自动补换行（JSON-lines 语义，readLine 依赖行终止符）。 */
        void write(String text) {
            String line = text.endsWith("\n") ? text : text + "\n";
            queue.add(line.getBytes(StandardCharsets.UTF_8));
        }

        /** 模拟进程退出：读取端随后读到 EOF。 */
        void closeWrite() {
            queue.add(new byte[0]);
        }

        @Override
        public int read() throws IOException {
            byte[] single = new byte[1];
            int count = read(single, 0, 1);
            return count == -1 ? -1 : single[0] & 0xFF;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (offset < 0 || length < 0 || length > buffer.length - offset) {
                throw new IndexOutOfBoundsException("offset=" + offset + " length=" + length);
            }
            if (length == 0) {
                return 0;
            }
            if (readerClosed) {
                throw new IOException("Stream closed");
            }
            while (current == null || current.available() == 0) {
                if (eof) {
                    return -1;
                }
                byte[] chunk = takeChunk();
                if (chunk.length == 0) {
                    eof = true;
                    return -1;
                }
                current = new ByteArrayInputStream(chunk);
            }
            return current.read(buffer, offset, length);
        }

        private byte[] takeChunk() throws IOException {
            try {
                return queue.take();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("读取被中断", e);
            }
        }

        @Override
        public int available() {
            int queued = 0;
            for (byte[] chunk : queue) {
                queued += chunk.length;
            }
            return (current == null ? 0 : current.available()) + queued;
        }

        @Override
        public void close() {
            readerClosed = true;
        }
    }

    /** 捕获 NodeIpc 写入 stdin 的字节并按 UTF-8 切行为 String 队列；close() 触发 onClose。 */
    static final class CapturingStdin extends OutputStream {
        private final BlockingQueue<String> lines = new LinkedBlockingQueue<>();
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        private final AtomicBoolean closed = new AtomicBoolean();
        private volatile Runnable closeAction = () -> {};

        void onClose(Runnable action) {
            this.closeAction = action;
        }

        /** 取下一条已写入的帧行；超时返回 null。 */
        String pollLine(Duration timeout) throws InterruptedException {
            return lines.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
        }

        boolean isClosed() {
            return closed.get();
        }

        @Override
        public synchronized void write(int b) {
            if (b == '\n') {
                flushLine();
            } else {
                buffer.write(b);
            }
        }

        @Override
        public synchronized void write(byte[] data, int offset, int length) {
            for (int i = 0; i < length; i++) {
                write(data[offset + i]);
            }
        }

        private void flushLine() {
            if (buffer.size() == 0) {
                return;
            }
            String line = buffer.toString(StandardCharsets.UTF_8);
            buffer.reset();
            lines.add(line);
        }

        @Override
        public synchronized void close() {
            if (closed.compareAndSet(false, true)) {
                flushLine();
                closeAction.run();
            }
        }
    }
}
