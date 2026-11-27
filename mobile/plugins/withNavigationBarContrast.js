const { withAndroidStyles, AndroidConfig } = require('expo/config-plugins')

module.exports = (config) =>
  withAndroidStyles(config, (mod) => {
    const styles = mod.modResults
    for (const name of ['android:enforceNavigationBarContrast', 'android:enforceStatusBarContrast']) {
      styles.resources.style = AndroidConfig.Styles.assignStylesValue(styles, {
        add: true,
        parent: AndroidConfig.Styles.getAppThemeGroup(),
        name,
        value: 'false'
      }).resources.style
    }
    return mod
  })
