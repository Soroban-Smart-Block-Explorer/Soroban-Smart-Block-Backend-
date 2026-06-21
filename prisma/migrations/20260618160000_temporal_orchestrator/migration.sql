-- CreateEnum
CREATE TYPE "TimerType" AS ENUM ('TIMELOCK', 'VESTING', 'DEADLINE', 'COOLDOWN', 'RECURRING', 'TIME_WEIGHTED', 'MULTI_STAGE', 'ABSOLUTE');

-- CreateEnum
CREATE TYPE "TimerStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXECUTED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "scheduled_operations" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "timer_type" "TimerType" NOT NULL,
    "status" "TimerStatus" NOT NULL,
    "function_name" TEXT NOT NULL,
    "description" TEXT,
    "trigger_time" TIMESTAMP(3) NOT NULL,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "interval_seconds" INTEGER,
    "recurrence_count" INTEGER,
    "events_executed" INTEGER NOT NULL DEFAULT 0,
    "parameters" JSONB,
    "source_tx" TEXT,
    "created_by" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "last_executed_at" TIMESTAMP(3),
    "next_trigger_at" TIMESTAMP(3),

    CONSTRAINT "scheduled_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vesting_schedules" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "beneficiary" TEXT NOT NULL,
    "total_amount" DECIMAL(65,30) NOT NULL,
    "cliff_date" TIMESTAMP(3),
    "cliff_amount" DECIMAL(65,30),
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "vesting_type" TEXT NOT NULL,
    "period_seconds" INTEGER,
    "amount_per_period" DECIMAL(65,30),
    "periods_total" INTEGER,
    "next_unlock_date" TIMESTAMP(3),
    "next_unlock_amount" DECIMAL(65,30),
    "total_unlocked" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_claimed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "source_tx" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vesting_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_timelocks" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "proposal_id" TEXT,
    "title" TEXT,
    "description" TEXT,
    "proposer" TEXT NOT NULL,
    "executor" TEXT,
    "targets" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "calldatas" JSONB NOT NULL,
    "operation_hash" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL,
    "min_delay" INTEGER NOT NULL,
    "execution_time" TIMESTAMP(3) NOT NULL,
    "expiry_time" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "executed_tx" TEXT,
    "cancelled_by" TEXT,
    "grace_period" INTEGER,

    CONSTRAINT "governance_timelocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "function_args" JSONB NOT NULL,
    "description" TEXT,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "successful_runs" INTEGER NOT NULL DEFAULT 0,
    "failed_runs" INTEGER NOT NULL DEFAULT 0,
    "max_runs" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_executions" (
    "id" TEXT NOT NULL,
    "cron_job_id" TEXT NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "tx_hash" TEXT,
    "error_message" TEXT,
    "gas_used" INTEGER,
    "duration" INTEGER,

    CONSTRAINT "cron_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timer_alerts" (
    "id" TEXT NOT NULL,
    "scheduled_op_id" TEXT,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "trigger_time" TIMESTAMP(3) NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "timer_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_operations_contract_address_idx" ON "scheduled_operations"("contract_address");
CREATE INDEX "scheduled_operations_timer_type_idx" ON "scheduled_operations"("timer_type");
CREATE INDEX "scheduled_operations_status_idx" ON "scheduled_operations"("status");
CREATE INDEX "scheduled_operations_next_trigger_at_idx" ON "scheduled_operations"("next_trigger_at");
CREATE INDEX "scheduled_operations_trigger_time_idx" ON "scheduled_operations"("trigger_time");

-- CreateIndex
CREATE INDEX "vesting_schedules_beneficiary_idx" ON "vesting_schedules"("beneficiary");
CREATE INDEX "vesting_schedules_contract_address_idx" ON "vesting_schedules"("contract_address");
CREATE INDEX "vesting_schedules_next_unlock_date_idx" ON "vesting_schedules"("next_unlock_date");
CREATE INDEX "vesting_schedules_status_idx" ON "vesting_schedules"("status");

-- CreateIndex
CREATE INDEX "governance_timelocks_contract_address_idx" ON "governance_timelocks"("contract_address");
CREATE INDEX "governance_timelocks_status_idx" ON "governance_timelocks"("status");
CREATE INDEX "governance_timelocks_execution_time_idx" ON "governance_timelocks"("execution_time");

-- CreateIndex
CREATE INDEX "cron_jobs_contract_address_idx" ON "cron_jobs"("contract_address");
CREATE INDEX "cron_jobs_next_run_at_idx" ON "cron_jobs"("next_run_at");

-- CreateIndex
CREATE INDEX "cron_executions_cron_job_id_executed_at_idx" ON "cron_executions"("cron_job_id", "executed_at" DESC);

-- CreateIndex
CREATE INDEX "timer_alerts_scheduled_op_id_idx" ON "timer_alerts"("scheduled_op_id");
CREATE INDEX "timer_alerts_trigger_time_idx" ON "timer_alerts"("trigger_time");

-- AddForeignKey
ALTER TABLE "cron_executions" ADD CONSTRAINT "cron_executions_cron_job_id_fkey" FOREIGN KEY ("cron_job_id") REFERENCES "cron_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
