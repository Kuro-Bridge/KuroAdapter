package com.kurobot.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/**
 * NodeSupervisor 看护器行为测试（DEBT-2）：真实 NodeIpc + FakeProcess，手动延迟调度器 +
 * 可注入时钟，覆盖退避重启 / 放弃终态 / 窗口滑出 / autoRestart=false / 停止看护 / 成功归零。
 */
class NodeSupervisorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final List<String> logs = new CopyOnWriteArrayList<>();
    private final LinkedBlockingQueue<FakeProcess> processes = new LinkedBlockingQueue<>();
    private final AtomicInteger factoryCalls = new AtomicInteger();

    /** 手动延迟调度器：记录退避值与任务，测试手动触发（含「停止后晚到」场景）。 */
    private static final class ManualDelayScheduler implements NodeSupervisor.DelayScheduler {
        final LinkedBlockingQueue<Long> delays = new LinkedBlockingQueue<>();
        final List<Runnable> tasks = new ArrayList<>();

        @Override
        public Runnable schedule(long delayMs, Runnable task) {
            delays.add(delayMs);
            tasks.add(task);
            return () -> delays.remove(delayMs);
        }

        /** 触发全部已记录任务（一次性：触发后清空，模拟定时器到点；含被 cancel 后仍晚到的防御路径）。 */
        void fireAll() {
            List<Runnable> snapshot = List.copyOf(tasks);
            tasks.clear();
            for (Runnable task : snapshot) {
                task.run();
            }
        }
    }

    private NodeSupervisor newSupervisor(NodeSupervisor.DelayScheduler scheduler, NodeSupervisor.Options options) {
        return new NodeSupervisor(
                listener -> {
                    factoryCalls.incrementAndGet();
                    FakeProcess process = new FakeProcess();
                    processes.add(process);
                    return new NodeIpc(
                            "node", Path.of("bundle.mjs"), null, listener, logs::add, (command, env, cwd) -> {
                                process.command = List.copyOf(command);
                                process.extraEnv = Map.copyOf(env);
                                process.workingDirectory = cwd;
                                return process;
                            });
                },
                new NodeIpcListener() {
                    @Override
                    public void onReady(int wsPort, boolean autoRestart) {}

                    @Override
                    public void onBroadcast(String message, IpcResult result) {}

                    @Override
                    public void onExecuteCommand(String command, IpcResult result) {}

                    @Override
                    public void onStderrLine(String line) {}

                    @Override
                    public void onProcessExited(Integer exitCode, String cause) {}
                },
                logs::add,
                scheduler,
                options);
    }

    private NodeSupervisor.Options options(boolean autoRestart, long windowMs, int maxFailures, AtomicLong clock) {
        return new NodeSupervisor.Options(autoRestart, List.of(10L, 20L, 30L), windowMs, maxFailures, clock::get);
    }

    /** 喂 ready 帧给当前实例，等待看护器确认就绪（start future 完成且本轮日志落位）。 */
    private void readyUp(FakeProcess process) throws Exception {
        NodeIpc ipc = latestIpc();
        int base = logs.size();
        int port = 49_000 + factoryCalls.get();
        process.stdout.write(readyFrame(port));
        assertEquals(port, ipc.start().get(5, TimeUnit.SECONDS));
        awaitLogSince(base, "看护中", "ready 后看护器应确认就绪");
    }

    private NodeIpc latestIpc() {
        NodeIpc ipc = supervisor.currentIpc();
        assertNotNull(ipc, "看护器应持有当前实例");
        return ipc;
    }

    /** 触发进程异常退出并等待本轮看护记账。exit 必须在 base 快照之后——否则读取线程可能在
     * exit 与取基线之间就把 WARN 写进日志，base 把目标行排除导致等待必然超时（实测竞态）。 */
    private void crashAndAwaitBookkeeping(FakeProcess process, int exitCode) throws Exception {
        int base = logs.size();
        process.exit(exitCode);
        awaitLogSince(base, "exit=" + exitCode, "退出通知应触发看护记账");
    }

    private NodeSupervisor supervisor;

    private void awaitLogSince(int fromIndex, String fragment, String message) throws Exception {
        // 15s：全量 :core:test 期间集成测试（真 node 进程）的负载可能推迟虚拟线程调度，
        // 5s 窗口曾实测偶发超时（DEBT2-NOTES：测试稳定性发现）
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            for (int i = fromIndex; i < logs.size(); i++) {
                if (logs.get(i).contains(fragment)) {
                    return;
                }
            }
            Thread.sleep(20);
        }
        assertTrue(
                logs.subList(Math.min(fromIndex, logs.size()), logs.size()).stream()
                        .anyMatch(line -> line.contains(fragment)),
                message + "，实际日志：" + logs);
    }

    private String readyFrame(int port) {
        ObjectNode root = MAPPER.createObjectNode();
        root.putObject("header").put("type", "ready");
        root.putObject("body").put("wsPort", port);
        return root.toString();
    }

    @Test
    void crashTriggersBackoffRestartAndRecoveryResetsCounter() throws Exception {
        ManualDelayScheduler scheduler = new ManualDelayScheduler();
        supervisor = newSupervisor(scheduler, options(true, 60_000, 3, new AtomicLong()));

        supervisor.start();
        FakeProcess first = processes.poll(5, TimeUnit.SECONDS);
        readyUp(first);

        crashAndAwaitBookkeeping(first, 137);
        assertEquals(10L, scheduler.delays.poll(1, TimeUnit.SECONDS), "第 1 次连续失败 → 退避 10ms");

        scheduler.fireAll();
        FakeProcess second = processes.poll(5, TimeUnit.SECONDS);
        assertNotNull(second, "退避到点应拉起新实例");
        readyUp(second);

        crashAndAwaitBookkeeping(second, 2);
        assertEquals(10L, scheduler.delays.poll(1, TimeUnit.SECONDS), "成功后连续失败已归零 → 再次退避 10ms");
    }

    @Test
    void threeFailuresInWindowGivesUpWithSevere() throws Exception {
        ManualDelayScheduler scheduler = new ManualDelayScheduler();
        supervisor = newSupervisor(scheduler, options(true, 60_000, 3, new AtomicLong()));

        supervisor.start();
        for (int i = 0; i < 3; i++) {
            FakeProcess process = processes.poll(5, TimeUnit.SECONDS);
            readyUp(process);
            crashAndAwaitBookkeeping(process, 1);
            if (i < 2) {
                scheduler.fireAll();
            }
        }

        assertTrue(supervisor.isGivenUp(), "窗口内 3 次失败应进入放弃终态");
        assertTrue(
                logs.stream().anyMatch(line -> line.contains("[NodeSupervisor][SEVERE]") && line.contains("放弃自动重启")),
                "放弃应 SEVERE 日志：" + logs);
        assertTrue(logs.stream().anyMatch(line -> line.contains("手动恢复路径")), "放弃应提示手动恢复路径");
        // 清掉放弃前（第 2 次失败后）的合法调度残留，观察是否出现「放弃后」的新调度
        scheduler.delays.clear();
        Thread.sleep(200);
        assertNull(scheduler.delays.poll(300, TimeUnit.MILLISECONDS), "放弃后不应再调度重启");
        assertEquals(3, factoryCalls.get(), "放弃后不再拉起新实例");
    }

    @Test
    void failuresOutsideWindowDoNotAccumulate() throws Exception {
        AtomicLong clock = new AtomicLong();
        ManualDelayScheduler scheduler = new ManualDelayScheduler();
        supervisor = newSupervisor(scheduler, options(true, 1_000, 3, clock));

        supervisor.start();
        for (int i = 0; i < 2; i++) {
            FakeProcess process = processes.poll(5, TimeUnit.SECONDS);
            readyUp(process);
            crashAndAwaitBookkeeping(process, 1);
            scheduler.fireAll();
        }

        // 时钟滑出窗口后第 3 次失败：旧失败出窗，不应放弃
        clock.set(10_000);
        FakeProcess third = processes.poll(5, TimeUnit.SECONDS);
        readyUp(third);
        crashAndAwaitBookkeeping(third, 1);

        assertFalse(supervisor.isGivenUp(), "窗口外的失败不应累计");
        assertEquals(10L, scheduler.delays.poll(1, TimeUnit.SECONDS), "滑窗后仍按退避调度重启");
    }

    @Test
    void autoRestartFalseSkipsRestart() throws Exception {
        ManualDelayScheduler scheduler = new ManualDelayScheduler();
        supervisor = newSupervisor(scheduler, options(false, 60_000, 3, new AtomicLong()));

        supervisor.start();
        FakeProcess process = processes.poll(5, TimeUnit.SECONDS);
        readyUp(process);
        crashAndAwaitBookkeeping(process, 5);

        assertTrue(
                logs.stream().anyMatch(line -> line.contains("autoRestart=false") && line.contains("不重启")),
                "false 分支应有日志：" + logs);
        assertNull(scheduler.delays.poll(300, TimeUnit.MILLISECONDS), "autoRestart=false 不应调度重启");
        assertFalse(supervisor.isGivenUp());
    }

    @Test
    void stopPreventsLateRestartTaskFromSpawning() throws Exception {
        ManualDelayScheduler scheduler = new ManualDelayScheduler();
        supervisor = newSupervisor(scheduler, options(true, 60_000, 3, new AtomicLong()));

        supervisor.start();
        FakeProcess process = processes.poll(5, TimeUnit.SECONDS);
        readyUp(process);
        crashAndAwaitBookkeeping(process, 1);
        assertEquals(10L, scheduler.delays.poll(1, TimeUnit.SECONDS));

        supervisor.stop("plugin disable");
        int callsBefore = factoryCalls.get();
        scheduler.fireAll(); // 模拟取消后仍晚到的任务：spawnAttempt 的 stopped 检查兜底
        assertEquals(callsBefore, factoryCalls.get(), "停止看护后挂起的重启不得再拉起实例");
    }

    @Test
    void backoffDelayMsCoversTiersAndCap() {
        List<Long> tiers = List.of(1_000L, 5_000L, 15_000L);
        assertEquals(1_000L, NodeSupervisor.backoffDelayMs(1, tiers));
        assertEquals(5_000L, NodeSupervisor.backoffDelayMs(2, tiers));
        assertEquals(15_000L, NodeSupervisor.backoffDelayMs(3, tiers));
        assertEquals(15_000L, NodeSupervisor.backoffDelayMs(9, tiers), "越界取末档封顶");
        assertEquals(1_000L, NodeSupervisor.backoffDelayMs(0, tiers), "非法输入按首档兜底");
    }
}
