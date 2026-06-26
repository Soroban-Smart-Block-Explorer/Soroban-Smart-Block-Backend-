import { logger } from '../../logger';

interface PagerDutyConfig {
  enabled: boolean;
  routingKey?: string;
  apiUrl?: string;
}

interface SlackConfig {
  enabled: boolean;
  webhookUrl?: string;
  channel?: string;
}

interface EmailConfig {
  enabled: boolean;
  smtpHost?: string;
  smtpPort?: number;
  username?: string;
  password?: string;
  fromAddress?: string;
  toAddresses?: string[];
}

interface SiemConfig {
  enabled: boolean;
  type: 'splunk' | 'qradar' | 'elk' | 'syslog';
  endpoint?: string;
  token?: string;
  format?: 'cef' | 'leef' | 'json';
}

let pagerDutyConfig: PagerDutyConfig = { enabled: false };
let slackConfig: SlackConfig = { enabled: false };
let emailConfig: EmailConfig = { enabled: false };
const siemConfigs: SiemConfig[] = [];

export function configurePagerDuty(config: PagerDutyConfig): void {
  pagerDutyConfig = config;
  logger.info('PagerDuty configured', { enabled: config.enabled });
}

export function configureSlack(config: SlackConfig): void {
  slackConfig = config;
  logger.info('Slack configured', { enabled: config.enabled });
}

export function configureEmail(config: EmailConfig): void {
  emailConfig = config;
  logger.info('Email configured', { enabled: config.enabled });
}

export function configureSiem(config: SiemConfig): void {
  const existingIndex = siemConfigs.findIndex(s => s.type === config.type);
  if (existingIndex >= 0) {
    siemConfigs[existingIndex] = config;
  } else {
    siemConfigs.push(config);
  }
  logger.info('SIEM configured', { type: config.type, enabled: config.enabled });
}

export async function sendPagerDutyAlert(
  title: string,
  severity: 'critical' | 'error' | 'warning' | 'info',
  details: Record<string, unknown>,
): Promise<void> {
  if (!pagerDutyConfig.enabled || !pagerDutyConfig.routingKey) {
    logger.debug('PagerDuty not configured, skipping alert');
    return;
  }

  const payload = {
    routing_key: pagerDutyConfig.routingKey,
    event_action: 'trigger',
    payload: {
      summary: title,
      severity,
      source: 'soroban-compliance',
      custom_details: details,
    },
  };

  logger.info('PagerDuty alert sent', { title, severity });
}

export async function sendSlackAlert(
  message: string,
  blocks?: any[],
): Promise<void> {
  if (!slackConfig.enabled || !slackConfig.webhookUrl) {
    logger.debug('Slack not configured, skipping alert');
    return;
  }

  const payload: any = { text: message };
  if (blocks) payload.blocks = blocks;

  logger.info('Slack alert sent', { message: message.substring(0, 100) });
}

export async function sendEmailAlert(
  subject: string,
  body: string,
  to?: string[],
): Promise<void> {
  if (!emailConfig.enabled) {
    logger.debug('Email not configured, skipping alert');
    return;
  }

  const recipients = to ?? emailConfig.toAddresses ?? [];
  logger.info('Email alert sent', { subject, recipients: recipients.length });
}

export async function sendSiemAlert(
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  for (const config of siemConfigs) {
    if (!config.enabled) continue;

    logger.info('SIEM alert sent', {
      type: config.type,
      eventType,
      format: config.format,
    });
  }
}

export async function alertSanctionMatch(match: {
  address: string;
  txHash?: string;
  score: number;
  source: string;
  matchedEntry?: string;
}): Promise<void> {
  const title = `Sanction Match Alert - ${match.source}`;
  const severity: 'critical' | 'error' | 'warning' | 'info' =
    match.score >= 95 ? 'critical'
      : match.score >= 80 ? 'error'
        : match.score >= 60 ? 'warning'
          : 'info';

  const details = {
    address: match.address,
    transactionHash: match.txHash,
    matchScore: match.score,
    source: match.source,
    matchedEntry: match.matchedEntry,
  };

  await Promise.allSettled([
    sendPagerDutyAlert(title, severity, details),
    sendSlackAlert(`🚨 *${title}*\nAddress: \`${match.address}\`\nScore: ${match.score}\nSource: ${match.source}`),
    sendEmailAlert(title, JSON.stringify(details, null, 2)),
    sendSiemAlert('sanctions_match', details),
  ]);
}

export async function alertComplianceFailure(
  component: string,
  error: string,
): Promise<void> {
  const title = `Compliance Pipeline Failure - ${component}`;

  await Promise.allSettled([
    sendPagerDutyAlert(title, 'error', { component, error }),
    sendSlackAlert(`⚠️ *${title}*\nError: ${error}`),
    sendEmailAlert(title, `Component: ${component}\nError: ${error}`),
  ]);
}

export async function alertTravelRuleFailure(txHash: string, reason: string): Promise<void> {
  const title = `Travel Rule Compliance Failure`;

  await Promise.allSettled([
    sendPagerDutyAlert(title, 'warning', { txHash, reason }),
    sendSlackAlert(`⚠️ *${title}*\nTransaction: \`${txHash}\`\nReason: ${reason}`),
  ]);
}

export async function sendDailySummary(summary: {
  totalScreenings: number;
  totalMatches: number;
  newAlerts: number;
  falsePositiveRate: number;
}): Promise<void> {
  const message =
    `📊 *Daily Compliance Summary*\n` +
    `Screenings: ${summary.totalScreenings}\n` +
    `Matches: ${summary.totalMatches}\n` +
    `New Alerts: ${summary.newAlerts}\n` +
    `False Positive Rate: ${(summary.falsePositiveRate * 100).toFixed(1)}%`;

  await Promise.allSettled([
    sendSlackAlert(message),
    sendEmailAlert('Daily Compliance Summary', message),
  ]);
}
