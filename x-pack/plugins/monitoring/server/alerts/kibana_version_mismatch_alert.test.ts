/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import { KibanaVersionMismatchAlert } from './kibana_version_mismatch_alert';
import { ALERT_KIBANA_VERSION_MISMATCH } from '../../common/constants';
import { fetchLegacyAlerts } from '../lib/alerts/fetch_legacy_alerts';
import { fetchClusters } from '../lib/alerts/fetch_clusters';

const RealDate = Date;

jest.mock('../lib/alerts/fetch_legacy_alerts', () => ({
  fetchLegacyAlerts: jest.fn(),
}));
jest.mock('../lib/alerts/fetch_clusters', () => ({
  fetchClusters: jest.fn(),
}));

describe('KibanaVersionMismatchAlert', () => {
  it('should have defaults', () => {
    const alert = new KibanaVersionMismatchAlert();
    expect(alert.type).toBe(ALERT_KIBANA_VERSION_MISMATCH);
    expect(alert.label).toBe('Kibana version mismatch');
    expect(alert.defaultThrottle).toBe('1d');
    // @ts-ignore
    expect(alert.actionVariables).toStrictEqual([
      {
        name: 'internalShortMessage',
        description: 'The short internal message generated by Elastic.',
      },
      {
        name: 'internalFullMessage',
        description: 'The full internal message generated by Elastic.',
      },
      { name: 'state', description: 'The current state of the alert.' },
      {
        name: 'versionList',
        description: 'The versions of Kibana running in this cluster.',
      },
      {
        name: 'clusterName',
        description: 'The cluster to which the instances belong.',
      },
      { name: 'action', description: 'The recommended action for this alert.' },
      {
        name: 'actionPlain',
        description: 'The recommended action for this alert, without any markdown.',
      },
    ]);
  });

  describe('execute', () => {
    function FakeDate() {}
    FakeDate.prototype.valueOf = () => 1;

    const clusterUuid = 'abc123';
    const clusterName = 'testCluster';
    const legacyAlert = {
      prefix: 'This cluster is running with multiple versions of Kibana.',
      message: 'Versions: [8.0.0, 7.2.1].',
      metadata: {
        severity: 1000,
        cluster_uuid: clusterUuid,
      },
    };
    const getUiSettingsService = () => ({
      asScopedToClient: jest.fn(),
    });
    const getLogger = () => ({
      debug: jest.fn(),
    });
    const monitoringCluster = null;
    const config = {
      ui: { ccs: { enabled: true }, container: { elasticsearch: { enabled: false } } },
    };
    const kibanaUrl = 'http://localhost:5601';

    const replaceState = jest.fn();
    const scheduleActions = jest.fn();
    const getState = jest.fn();
    const executorOptions = {
      services: {
        callCluster: jest.fn(),
        alertInstanceFactory: jest.fn().mockImplementation(() => {
          return {
            replaceState,
            scheduleActions,
            getState,
          };
        }),
      },
      state: {},
    };

    beforeEach(() => {
      // @ts-ignore
      Date = FakeDate;
      (fetchLegacyAlerts as jest.Mock).mockImplementation(() => {
        return [legacyAlert];
      });
      (fetchClusters as jest.Mock).mockImplementation(() => {
        return [{ clusterUuid, clusterName }];
      });
    });

    afterEach(() => {
      Date = RealDate;
      replaceState.mockReset();
      scheduleActions.mockReset();
      getState.mockReset();
    });

    it('should fire actions', async () => {
      const alert = new KibanaVersionMismatchAlert();
      alert.initializeAlertType(
        getUiSettingsService as any,
        monitoringCluster as any,
        getLogger as any,
        config as any,
        kibanaUrl
      );
      const type = alert.getAlertType();
      await type.executor({
        ...executorOptions,
        // @ts-ignore
        params: alert.defaultParams,
      } as any);
      expect(replaceState).toHaveBeenCalledWith({
        alertStates: [
          {
            cluster: { clusterUuid: 'abc123', clusterName: 'testCluster' },
            ccs: null,
            ui: {
              isFiring: true,
              message: {
                text: 'Multiple versions of Kibana ([8.0.0, 7.2.1]) running in this cluster.',
              },
              severity: 'warning',
              resolvedMS: 0,
              triggeredMS: 1,
              lastCheckedMS: 0,
            },
          },
        ],
      });
      expect(scheduleActions).toHaveBeenCalledWith('default', {
        action:
          '[View instances](http://localhost:5601/app/monitoring#kibana/instances?_g=(cluster_uuid:abc123))',
        actionPlain: 'Verify you have the same version across all instances.',
        internalFullMessage:
          'Kibana version mismatch alert is firing for testCluster. Kibana is running [8.0.0, 7.2.1]. [View instances](http://localhost:5601/app/monitoring#kibana/instances?_g=(cluster_uuid:abc123))',
        internalShortMessage:
          'Kibana version mismatch alert is firing for testCluster. Verify you have the same version across all instances.',
        versionList: '[8.0.0, 7.2.1]',
        clusterName,
        state: 'firing',
      });
    });

    it('should not fire actions if there is no legacy alert', async () => {
      (fetchLegacyAlerts as jest.Mock).mockImplementation(() => {
        return [];
      });
      const alert = new KibanaVersionMismatchAlert();
      alert.initializeAlertType(
        getUiSettingsService as any,
        monitoringCluster as any,
        getLogger as any,
        config as any,
        kibanaUrl
      );
      const type = alert.getAlertType();
      await type.executor({
        ...executorOptions,
        // @ts-ignore
        params: alert.defaultParams,
      } as any);
      expect(replaceState).not.toHaveBeenCalledWith({});
      expect(scheduleActions).not.toHaveBeenCalled();
    });

    it('should resolve with a resolved message', async () => {
      (fetchLegacyAlerts as jest.Mock).mockImplementation(() => {
        return [
          {
            ...legacyAlert,
            resolved_timestamp: 1,
          },
        ];
      });
      (getState as jest.Mock).mockImplementation(() => {
        return {
          alertStates: [
            {
              cluster: {
                clusterUuid,
                clusterName,
              },
              ccs: null,
              ui: {
                isFiring: true,
                message: null,
                severity: 'danger',
                resolvedMS: 0,
                triggeredMS: 1,
                lastCheckedMS: 0,
              },
            },
          ],
        };
      });
      const alert = new KibanaVersionMismatchAlert();
      alert.initializeAlertType(
        getUiSettingsService as any,
        monitoringCluster as any,
        getLogger as any,
        config as any,
        kibanaUrl
      );
      const type = alert.getAlertType();
      await type.executor({
        ...executorOptions,
        // @ts-ignore
        params: alert.defaultParams,
      } as any);
      expect(replaceState).toHaveBeenCalledWith({
        alertStates: [
          {
            cluster: { clusterUuid, clusterName },
            ccs: null,
            ui: {
              isFiring: false,
              message: {
                text: 'All versions of Kibana are the same in this cluster.',
              },
              severity: 'danger',
              resolvedMS: 1,
              triggeredMS: 1,
              lastCheckedMS: 0,
            },
          },
        ],
      });
      expect(scheduleActions).toHaveBeenCalledWith('default', {
        internalFullMessage: 'Kibana version mismatch alert is resolved for testCluster.',
        internalShortMessage: 'Kibana version mismatch alert is resolved for testCluster.',
        clusterName,
        state: 'resolved',
      });
    });
  });
});
