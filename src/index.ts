import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

/**
 * Initialization data for the jupyterlab_url_params_ext extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_url_params_ext:plugin',
  description: 'A JupyterLab extension to fill cell params based on URL params.',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('JupyterLab extension jupyterlab_url_params_ext is activated!');
  }
};

export default plugin;
