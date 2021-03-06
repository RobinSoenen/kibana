/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { breadcrumbsProvider } from './breadcrumbs';
import { MonitoringMainController } from '../directives/main';
import { Legacy } from '../legacy_shims';

describe('Monitoring Breadcrumbs Service', () => {
  const core = {
    notifications: {},
    application: {},
    i18n: {},
    chrome: {},
  };
  const data = {
    query: {
      timefilter: {
        timefilter: {
          isTimeRangeSelectorEnabled: () => true,
          getTime: () => 1,
          getRefreshInterval: () => 1,
        },
      },
    },
  };
  const isCloud = false;
  const triggersActionsUi = {};

  beforeAll(() => {
    Legacy.init({
      core,
      data,
      isCloud,
      triggersActionsUi,
    });
  });

  it('in Cluster Alerts', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        name: 'alerts',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
      { url: '#/overview', label: 'test-cluster-foo', ignoreGlobalState: false },
    ]);
  });

  it('in Cluster Overview', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        name: 'overview',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
    ]);
  });

  it('in ES Node - Advanced', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        product: 'elasticsearch',
        name: 'nodes',
        instance: 'es-node-name-01',
        resolver: 'es-node-resolver-01',
        page: 'advanced',
        tabIconClass: 'fa star',
        tabIconLabel: 'Master Node',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
      { url: '#/overview', label: 'test-cluster-foo', ignoreGlobalState: false },
      { url: '#/elasticsearch', label: 'Elasticsearch', ignoreGlobalState: false },
      {
        url: '#/elasticsearch/nodes',
        label: 'Nodes',
        testSubj: 'breadcrumbEsNodes',
        ignoreGlobalState: false,
      },
      { url: null, label: 'es-node-name-01', ignoreGlobalState: false },
    ]);
  });

  it('in Kibana Overview', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        product: 'kibana',
        name: 'overview',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
      { url: '#/overview', label: 'test-cluster-foo', ignoreGlobalState: false },
      { url: null, label: 'Kibana', ignoreGlobalState: false },
    ]);
  });

  /**
   * <monitoring-main product="logstash" name="nodes">
   */
  it('in Logstash Listing', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        product: 'logstash',
        name: 'listing',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
      { url: '#/overview', label: 'test-cluster-foo', ignoreGlobalState: false },
      { url: null, label: 'Logstash', ignoreGlobalState: false },
    ]);
  });

  /**
   * <monitoring-main product="logstash" page="pipeline">
   */
  it('in Logstash Pipeline Viewer', () => {
    const controller = new MonitoringMainController();
    controller.setup({
      clusterName: 'test-cluster-foo',
      licenseService: {},
      breadcrumbsService: breadcrumbsProvider(),
      attributes: {
        product: 'logstash',
        page: 'pipeline',
        pipelineId: 'main',
        pipelineHash: '42ee890af9...',
      },
    });
    expect(controller.breadcrumbs).to.eql([
      { url: '#/home', label: 'Clusters', testSubj: 'breadcrumbClusters', ignoreGlobalState: true },
      { url: '#/overview', label: 'test-cluster-foo', ignoreGlobalState: false },
      { url: '#/logstash', label: 'Logstash', ignoreGlobalState: false },
      { url: '#/logstash/pipelines', label: 'Pipelines', ignoreGlobalState: false },
    ]);
  });
});
