import { DiscoveryModule, DiscoveryService } from '@golevelup/nestjs-discovery';
import { createConfigurableDynamicRootModule } from '@golevelup/nestjs-modules';
import {
  BadRequestException,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ExternalContextCreator } from '@nestjs/core/helpers/external-context-creator';
import { flatten, groupBy } from 'lodash';
import {
  HASURA_EVENT_HANDLER,
  HASURA_MODULE_CONFIG,
  HASURA_ACTION_HANDLER,
} from './hasura.constants';
import { InjectHasuraConfig } from './hasura.decorators';
import { HasuraRouterController } from './hasura.router.controller';
import { HasuraEventHandlerHeaderGuard } from './hasura.event-handler.guard';
import { EventHandlerService } from './hasura.event-handler.service';
import {
  HasuraEvent,
  HasuraEventHandlerConfig,
  HasuraModuleConfig,
  HasuraScheduledEventPayload,
} from './hasura.events.interfaces';
import { ActionHandlerService } from './hasura.action-handler.service';
import { HasuraAction } from './hasura.actions.interfaces';
import fetch from 'node-fetch';

function isHasuraEvent(value: any): value is HasuraEvent {
  return (
    value.id &&
    typeof value.table == 'object' &&
    typeof value.trigger == 'object'
  )
}

function isHasuraScheduledEventPayload(
  value: any,
): value is HasuraScheduledEventPayload {
  return (
    value.id &&
    value.name &&
    value.scheduled_time &&
    typeof value.payload == 'object'
  )
}

@Module({
  imports: [DiscoveryModule],
  controllers: [HasuraRouterController],
})
export class HasuraModule
  extends createConfigurableDynamicRootModule<HasuraModule, HasuraModuleConfig>(
    HASURA_MODULE_CONFIG,
    {
      providers: [
        {
          provide: Symbol('CONTROLLER_HACK'),
          useFactory: (config: HasuraModuleConfig) => {
            const controllerPrefix = config.controllerPrefix || 'hasura';

            Reflect.defineMetadata(
              PATH_METADATA,
              controllerPrefix,
              HasuraRouterController
            );
          },
          inject: [HASURA_MODULE_CONFIG],
        },
        EventHandlerService,
        ActionHandlerService,
        HasuraEventHandlerHeaderGuard,
      ],
      exports: [HASURA_MODULE_CONFIG],
    }
  )
  implements OnModuleInit {
  private readonly logger = new Logger(HasuraModule.name);

  constructor(
    private readonly discover: DiscoveryService,
    private readonly externalContextCreator: ExternalContextCreator,
    @InjectHasuraConfig()
    private readonly hasuraModuleConfig: HasuraModuleConfig
  ) {
    super();
  }

  public async onModuleInit() {
    this.logger.log('Initializing Hasura Module');
    await this.configureHasuraEventHandlers();
    await this.configureHasuraActionHandlers();
  }

  private async configureHasuraActionHandlers() {
    this.logger.log('Connecting Hasura Action Handlers');

    const [actionHandlerService] = await (
      await this.discover.providers((x) => x.name === ActionHandlerService.name)
    ).map((x) => x.instance);

    if (!(actionHandlerService instanceof ActionHandlerService)) {
      throw new Error(`Could not find Hasura Event Handler Service.`);
    }

    const actionHandlerNames = await this.discover.providerMethodsWithMetaAtKey<
      string
    >(HASURA_ACTION_HANDLER);

    const grouped = groupBy(
      actionHandlerNames,
      (x) => x.discoveredMethod.parentClass.name
    );

    const actionHandlers = flatten(
      Object.keys(grouped).map((x) => {
        this.logger.log(`Registering hasura action handlers from ${x}`);

        return grouped[x].map(({ discoveredMethod, meta: actionName }) => {
          this.logger.log(
            `Action '${actionName}' -> ${x}.${discoveredMethod.methodName}`
          );
          return [
            actionName,
            this.externalContextCreator.create(
              discoveredMethod.parentClass.instance,
              discoveredMethod.handler,
              discoveredMethod.methodName
            ),
          ] as const;
        });
      })
    );

    // TODO: Do we want to validate that there are duplicate action handlers here? What should we do if we find them?
    const actionHandlerMap = new Map(actionHandlers);

    const handleAction = async (
      action: HasuraAction,
      headers: Record<string, string>
    ) => {
      const handler = actionHandlerMap.get(action.action.name);
      if (!handler) {
        const errorMessage = `Handler not found for action: ${action.action.name}`;
        this.logger.error(errorMessage);
        throw new BadRequestException(errorMessage);
      }

      return handler(action.input, action, headers);
    };

    actionHandlerService.handleAction = handleAction;
  }

  private async configureHasuraEventHandlers() {
    this.logger.log('Connecting Hasura Events');

    const [eventHandlerService] = await (
      await this.discover.providers((x) => x.name === EventHandlerService.name)
    ).map((x) => x.instance);

    if (!(eventHandlerService instanceof EventHandlerService)) {
      throw new Error(`Could not find Hasura Event Handler Service.`);
    }

    const eventHandlerMeta = await this.discover.providerMethodsWithMetaAtKey<
      HasuraEventHandlerConfig
    >(HASURA_EVENT_HANDLER);

    const grouped = groupBy(
      eventHandlerMeta,
      (x) => x.discoveredMethod.parentClass.name
    );

    const eventHandlers = flatten(
      Object.keys(grouped).map((x) => {
        this.logger.log(`Registering hasura event handlers from ${x}`);

        return grouped[x].map(({ discoveredMethod, meta: config }) => {
          if (!config.table && !config.triggerName) {
            throw new Error(
              'Hasura Event Handler is invalid. Specify either trigger name or table mapping'
            );
          }

          if (config.table) {
            this.logger.warn(
              `Event binding based on schema and table is deprecated and will be removed in a future release. Consider replacing the binding on ${discoveredMethod.methodName} with triggerName`
            );
          }

          if (config.table && config.triggerName) {
            this.logger.warn(
              `Both table and trigger bindings are set for ${discoveredMethod.methodName}. This is not recommended and will cause duplicate message processing`
            );
          }

          const key =
            config.triggerName ||
            `${config.table?.schema ? config.table?.schema : 'public'}-${
              config.table?.name
            }`;

          return {
            key,
            handler: this.externalContextCreator.create(
              discoveredMethod.parentClass.instance,
              discoveredMethod.handler,
              discoveredMethod.methodName
            ),
          };
        });
      })
    );

    const handleEvent = (evt: Partial<HasuraEvent> | HasuraScheduledEventPayload) => {
      const keys = isHasuraEvent(evt)
        ? [evt.trigger?.name, `${evt?.table?.schema}-${evt?.table?.name}`]
        : isHasuraScheduledEventPayload(evt)
        ? [evt.name]
        : null
      if (!keys) throw new Error('Not a Hasura Event')

      // TODO: this should use a map for faster lookups
      const handlers = eventHandlers.filter((x) => keys.includes(x.key));

      if (this.hasuraModuleConfig.enableEventLogs) {
        this.logger.log(`Received event for: ${keys}`);
      }

      if (handlers && handlers.length) {
        return Promise.all(handlers.map((x) => x.handler(evt)));
      } else {
        const errorMessage = `Handler not found for ${keys}`;
        this.logger.error(errorMessage);
        throw new BadRequestException(errorMessage);
      }
    };

    eventHandlerService.handleEvent = handleEvent;
  }
}
