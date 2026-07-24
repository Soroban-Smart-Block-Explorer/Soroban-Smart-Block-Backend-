import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

const Tab = createBottomTabNavigator();

function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Soroban Explorer</Text>
      <Text style={styles.subtitle}>Mobile SDK Active</Text>
    </View>
  );
}

function WalletScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Wallet View</Text>
    </View>
  );
}

function ContractScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Contract View</Text>
    </View>
  );
}

function AlertsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Alerts</Text>
    </View>
  );
}

function SettingsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
    </View>
  );
}

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
        tabBarStyle: { backgroundColor: '#0f172a', borderTopColor: '#1e293b' },
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#64748b',
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Wallet" component={WalletScreen} />
      <Tab.Screen name="Contracts" component={ContractScreen} />
      <Tab.Screen name="Alerts" component={AlertsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
  },
  loading: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [isLocked, setIsLocked] = useState(true);

  useEffect(() => {
    async function init() {
      const { hasHardwareAsync, authenticateAsync } = await import('expo-local-authentication');
      const hasHardware = await hasHardwareAsync();
      if (hasHardware) {
        const result = await authenticateAsync({
          promptMessage: 'Unlock Soroban Explorer',
        });
        setIsLocked(!result.success);
      } else {
        setIsLocked(false);
      }
      setIsReady(true);
    }
    init();
  }, []);

  if (!isReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  if (isLocked) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Soroban Explorer</Text>
        <Text style={styles.subtitle}>Locked</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer
        linking={{
          prefixes: ['soroban://', 'https://soroban.network'],
          config: {
            screens: {
              Home: '',
              Wallet: 'wallet/:address',
              Contracts: 'contract/:address',
              Alerts: 'alerts',
              Settings: 'settings',
            },
          },
        }}
      >
        <HomeTabs />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
  },
  loading: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
