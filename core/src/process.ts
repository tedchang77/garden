/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"
import { keyBy, flatten, without, uniq } from "lodash"

import { GardenModule } from "./types/module"
import { BaseTask } from "./tasks/base"
import { GraphResults } from "./task-graph"
import { isModuleLinked } from "./util/ext-source-util"
import { Garden } from "./garden"
import { EmojiName, LogEntry } from "./logger/log-entry"
import { ConfigGraph } from "./config-graph"
import { dedent, naturalList } from "./util/string"
import { ConfigurationError } from "./exceptions"
import { uniqByName } from "./util/util"
import { printEmoji, renderDivider } from "./logger/util"
import { CommandTaskSettings } from "./commands/base"
import { Events } from "./events"
import { BuildTask } from "./tasks/build"
import { DeployTask } from "./tasks/deploy"
import { filterTestConfigs, TestTask } from "./tasks/test"
import { testFromConfig } from "./types/test"
import { applyTaskSettings } from "./commands/dev"

export type ProcessHandler = (graph: ConfigGraph, module: GardenModule) => Promise<BaseTask[]>

interface ProcessParams {
  garden: Garden
  graph: ConfigGraph
  log: LogEntry
  footerLog?: LogEntry
  watch: boolean
  initialTasks: BaseTask[]
  // use this if the behavior should be different on watcher changes than on initial processing
  changeHandler: ProcessHandler
  taskSettings?: CommandTaskSettings
}

export interface ProcessModulesParams extends ProcessParams {
  modules: GardenModule[]
}

export interface ProcessResults {
  taskResults: GraphResults
  restartRequired?: boolean
}

export async function processModules({
  garden,
  graph,
  log,
  footerLog,
  modules,
  initialTasks,
  watch,
  changeHandler,
  taskSettings,
}: ProcessModulesParams): Promise<ProcessResults> {
  log.silly("Starting processModules")

  // Let the user know if any modules are linked to a local path
  const linkedModulesMsg = modules
    .filter((m) => isModuleLinked(m, garden))
    .map((m) => `${chalk.cyan(m.name)} linked to path ${chalk.white(m.path)}`)
    .map((msg) => "  " + msg) // indent list

  if (linkedModulesMsg.length > 0) {
    log.info(renderDivider())
    log.info(chalk.gray(`Following modules are linked to a local path:\n${linkedModulesMsg.join("\n")}`))
    log.info(renderDivider())
  }

  let statusLine: LogEntry

  if (watch && !!footerLog) {
    statusLine = footerLog.info("").placeholder()

    garden.events.on("taskGraphProcessing", () => {
      const emoji = printEmoji("hourglass_flowing_sand", statusLine)
      statusLine.setState(`${emoji} Processing...`)
    })
  }

  const results = await garden.processTasks(initialTasks)

  if (!watch) {
    return {
      taskResults: results,
      restartRequired: false,
    }
  }

  const deps = graph.getDependenciesForMany({
    nodeType: "build",
    names: modules.map((m) => m.name),
    recursive: true,
  })
  const modulesToWatch = uniqByName(deps.build.concat(modules))
  const modulesByName = keyBy(modulesToWatch, "name")

  await garden.startWatcher(graph)

  const waiting = () => {
    if (!!statusLine) {
      statusLine.setState({ emoji: "clock2", msg: chalk.gray("Waiting for code changes...") })
    }

    garden.events.emit("watchingForChanges", {})
  }

  let restartRequired = true

  await new Promise((resolve) => {
    garden.events.on("taskGraphComplete", () => {
      waiting()
    })

    garden.events.on("_restart", () => {
      log.debug({ symbol: "info", msg: `Manual restart triggered` })
      resolve({})
    })

    garden.events.on("_exit", () => {
      log.debug({ symbol: "info", msg: `Manual exit triggered` })
      restartRequired = false
      resolve({})
    })

    garden.events.on("projectConfigChanged", async () => {
      if (await validateConfigChange(garden, log, garden.projectRoot, "changed")) {
        log.info({
          symbol: "info",
          msg: `Project configuration changed, reloading...`,
        })
        resolve({})
      }
    })

    garden.events.on("configAdded", async (event) => {
      if (await validateConfigChange(garden, log, event.path, "added")) {
        log.info({
          symbol: "info",
          msg: `Garden config added at ${event.path}, reloading...`,
        })
        resolve({})
      }
    })

    garden.events.on("configRemoved", async (event) => {
      if (await validateConfigChange(garden, log, event.path, "removed")) {
        log.info({
          symbol: "info",
          msg: `Garden config at ${event.path} removed, reloading...`,
        })
        resolve({})
      }
    })

    garden.events.on("moduleConfigChanged", async (event) => {
      if (await validateConfigChange(garden, log, event.path, "changed")) {
        const moduleNames = event.names
        const section = moduleNames.length === 1 ? moduleNames[0] : undefined
        log.info({
          symbol: "info",
          section,
          msg: `Module configuration changed, reloading...`,
        })
        resolve({})
      }
    })

    garden.events.on("moduleSourcesChanged", async (event) => {
      graph = await garden.getConfigGraph(log)
      const changedModuleNames = event.names.filter((moduleName) => !!modulesByName[moduleName])

      if (changedModuleNames.length === 0) {
        return
      }

      // Make sure the modules' versions are up to date.
      const changedModules = graph.getModules({ names: changedModuleNames })

      const moduleTasks = flatten(
        await Bluebird.map(changedModules, async (m) => {
          modulesByName[m.name] = m
          return changeHandler!(graph, m)
        })
      )
      await garden.processTasks(moduleTasks)
    })

    if (taskSettings) {
      // Handle Cloud events
      const params = {
        garden,
        graph,
        log,
      }
      garden.events.on("buildRequested", async (event: Events["buildRequested"]) => {
        graph = await garden.getConfigGraph(log)
        log.info("")
        log.info({ emoji: "hammer", msg: chalk.yellow(`Build requested for ${chalk.white(event.moduleName)}`) })
        const tasks = await cloudEventHandlers.buildRequested({ ...params, request: event })
        await garden.processTasks(tasks)
      })
      garden.events.on("deployRequested", async (event: Events["deployRequested"]) => {
        graph = await garden.getConfigGraph(log)
        let prefix: string
        let emoji: EmojiName
        if (event.hotReload) {
          emoji = "fire"
          prefix = `Hot reload-enabled deployment`
        } else {
          if (event.devMode) {
            emoji = "zap"
            prefix = `Dev-mode deployment`
          } else {
            emoji = "rocket"
            prefix = "Deployment"
          }
        }
        const msg = `${prefix} requested for ${chalk.white(event.serviceName)}`
        log.info("")
        log.info({ emoji, msg: chalk.yellow(msg) })
        const deployTask = await cloudEventHandlers.deployRequested({ ...params, request: event, taskSettings })
        await garden.processTasks([deployTask])
      })
      garden.events.on("testRequested", async (event: Events["testRequested"]) => {
        graph = await garden.getConfigGraph(log)
        const testNames = event.testNames
        let suffix = ""
        if (testNames) {
          suffix = ` (only ${chalk.white(naturalList(testNames))})`
        }
        const msg = chalk.yellow(`Tests requested for ${chalk.white(event.moduleName)}${suffix}`)
        log.info("")
        log.info({ emoji: "thermometer", msg })
        const testTasks = await cloudEventHandlers.testRequested({ ...params, request: event, taskSettings })
        await garden.processTasks(testTasks)
      })
      garden.events.on("updateBuildOnWatchModules", (event: Events["updateBuildOnWatchModules"]) => {
        const moduleNames = event.moduleNames
        cloudEventHandlers.updateBuildOnWatchModules(moduleNames, taskSettings)
        let msg
        if (moduleNames.length === 0) {
          msg = `Not rebuilding when sources change unless required by deploys or tests`
        } else {
          msg = `Now rebuilding ${chalk.white(naturalList(moduleNames))} when sources change`
        }
        log.info("")
        log.info({ emoji: "recycle", msg: chalk.yellow(msg) })
      })
      garden.events.on("updateDeployOnWatchServices", (event: Events["updateDeployOnWatchServices"]) => {
        const serviceNames = event.serviceNames
        cloudEventHandlers.updateDeployOnWatchServices(serviceNames, taskSettings)
        let msg
        if (serviceNames.length === 0) {
          msg = `Not redeploying on watch unless required by tests`
        } else {
          msg = `Now redeploying ${chalk.white(naturalList(serviceNames))} when sources change`
        }
        log.info("")
        log.info({ emoji: "recycle", msg: chalk.yellow(msg) })
      })
      garden.events.on("updateTestOnWatchModules", (event: Events["updateTestOnWatchModules"]) => {
        const moduleNames = event.moduleNames
        cloudEventHandlers.updateTestOnWatchModules(moduleNames, taskSettings)
        let msg
        if (moduleNames.length === 0) {
          msg = `Not running tests when sources change`
        } else {
          msg = `Now running tests for ${chalk.white(naturalList(moduleNames))} when sources change`
        }
        log.info("")
        log.info({ emoji: "recycle", msg: chalk.yellow(msg) })
      })
      // deployOnWatch(serviceName[])
      // testOnWatch(serviceName[])
      // buildOnWatch(serviceName[])
      // buildModule(moduleName)
      // deployService(serviceName)
      // testModule(moduleName, testName | null)
      // runTask(taskName)
    }

    waiting()
  })

  return {
    taskResults: {}, // TODO: Return latest results for each task key processed between restarts?
    restartRequired,
  }
}

interface CloudEventHandlerCommonParams {
  garden: Garden
  graph: ConfigGraph
  log: LogEntry
}

export const cloudEventHandlers = {
  buildRequested: async (params: CloudEventHandlerCommonParams & { request: Events["buildRequested"] }) => {
    const { garden, graph, log } = params
    const { moduleName, force } = params.request
    const tasks = await BuildTask.factory({
      garden,
      log,
      graph,
      module: graph.getModule(moduleName),
      force,
    })
    return tasks
  },
  testRequested: async (
    params: CloudEventHandlerCommonParams & { request: Events["testRequested"]; taskSettings: CommandTaskSettings }
  ) => {
    const { garden, graph, log, taskSettings } = params
    const { moduleName, testNames, force, forceBuild } = params.request
    const module = graph.getModule(moduleName)
    return filterTestConfigs(module.testConfigs, testNames).map((config) => {
      return new TestTask({
        garden,
        graph,
        log,
        force,
        forceBuild,
        test: testFromConfig(module, config, graph),
        devModeServiceNames: taskSettings.devModeServiceNames,
        hotReloadServiceNames: taskSettings.hotReloadServiceNames,
      })
    })
  },
  deployRequested: async (
    params: CloudEventHandlerCommonParams & { request: Events["deployRequested"]; taskSettings: CommandTaskSettings }
  ) => {
    const { garden, graph, log, taskSettings } = params
    const { serviceName, devMode, hotReload, force, forceBuild } = params.request
    const allServiceNames = graph.getServices().map((s) => s.name)

    taskSettings.devModeServiceNames = devMode
      ? addToTaskSettingsList(serviceName, taskSettings.devModeServiceNames)
      : removeFromTaskSettingsList(serviceName, taskSettings.devModeServiceNames, allServiceNames)

    if (!devMode) {
      taskSettings.hotReloadServiceNames = hotReload
        ? addToTaskSettingsList(serviceName, taskSettings.hotReloadServiceNames)
        : removeFromTaskSettingsList(serviceName, taskSettings.hotReloadServiceNames, allServiceNames)
    }

    const { hotReloadServiceNames, devModeServiceNames } = applyTaskSettings(graph, taskSettings)

    const deployTask = new DeployTask({
      garden,
      log,
      graph,
      service: graph.getService(serviceName),
      force,
      forceBuild,
      fromWatch: true,
      hotReloadServiceNames,
      devModeServiceNames,
    })
    return deployTask
  },
  updateBuildOnWatchModules: (
    moduleNames: Events["updateBuildOnWatchModules"]["moduleNames"],
    taskSettings: CommandTaskSettings
  ) => {
    taskSettings.buildModuleNames = moduleNames
    return taskSettings
  },
  updateDeployOnWatchServices: (
    serviceNames: Events["updateDeployOnWatchServices"]["serviceNames"],
    taskSettings: CommandTaskSettings
  ) => {
    taskSettings.deployServiceNames = serviceNames
    return taskSettings
  },
  updateTestOnWatchModules: (
    moduleNames: Events["updateTestOnWatchModules"]["moduleNames"],
    taskSettings: CommandTaskSettings
  ) => {
    taskSettings.testModuleNames = moduleNames
    return taskSettings
  },
}

function addToTaskSettingsList(name: string, currentList: string[]): string[] {
  return currentList[0] === "*" ? currentList : uniq([...currentList, name])
}

function removeFromTaskSettingsList(name: string, currentList: string[], fullList: string[]): string[] {
  return currentList[0] === "*" ? without(fullList, name) : without(currentList, name)
}

/**
 * When config files change / are added / are removed, we try initializing a new Garden instance
 * with the changed config files and performing a bit of validation on it before proceeding with
 * a restart. If a config error was encountered, we simply log the error and keep the existing
 * Garden instance.
 *
 * Returns true if no configuration errors occurred.
 */
async function validateConfigChange(
  garden: Garden,
  log: LogEntry,
  changedPath: string,
  operationType: "added" | "changed" | "removed"
): Promise<boolean> {
  try {
    const nextGarden = await Garden.factory(garden.projectRoot, garden.opts)
    await nextGarden.getConfigGraph(log)
    await nextGarden.close()
  } catch (error) {
    if (error instanceof ConfigurationError) {
      const msg = dedent`
        Encountered configuration error after ${changedPath} was ${operationType}:

        ${error.message}

        Keeping existing configuration and skipping restart.`
      log.error({ symbol: "error", msg, error })
      return false
    } else {
      throw error
    }
  }
  return true
}
